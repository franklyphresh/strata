import * as anchor from "@project-serum/anchor";
import { IdlTypes, Program, Provider } from "@project-serum/anchor";
import {
  createMintInstructions,
  getMintInfo,
  getTokenAccount,
  sleep,
} from "@project-serum/common";
import {
  AccountInfo,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintInfo,
  NATIVE_MINT,
  Token,
  TOKEN_PROGRAM_ID,
  u64,
} from "@solana/spl-token";
import {
  Commitment,
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  AnchorSdk,
  createMetadata,
  Data,
  getAssociatedAccountBalance,
  InstructionResult,
  percent,
  TypedAccountParser,
} from "@strata-foundation/spl-utils";
import BN from "bn.js";
import { BondingHierarchy } from "./bondingHierarchy";
import { fromCurve, IPricingCurve } from "./curves";
import {
  CurveV0,
  ProgramStateV0,
  SplTokenBondingIDL,
  TokenBondingV0,
} from "./generated/spl-token-bonding";
import { BondingPricing } from "./pricing";
import { asDecimal, toBN, toNumber, toU128 } from "./utils";
import { ITransitionFee } from "./curves";

export * from "./bondingHierarchy";
export * from "./curves";
export * from "./generated/spl-token-bonding";
export * from "./pricing";
export * from "./utils";

/**
 * The curve config required by the smart contract is unwieldy, implementors of `CurveConfig` wrap the interface
 */
interface ICurveConfig {
  toRawConfig(): CurveV0;
}

interface IPrimitiveCurve {
  toRawPrimitiveConfig(): any;
}



/**
 * Curve configuration for c(S^(pow/frac)) + b
 */
export class ExponentialCurveConfig implements ICurveConfig, IPrimitiveCurve {
  c: BN;
  b: BN;
  pow: number;
  frac: number;

  constructor({
    c = 1,
    b = 0,
    pow = 1,
    frac = 1,
  }: {
    c?: number | BN;
    b?: number | BN;
    pow?: number;
    frac?: number;
  }) {
    this.c = toU128(c);
    this.b = toU128(b);
    this.pow = pow;
    this.frac = frac;

    if (this.b.gt(new BN(0)) && this.c.gt(new BN(0))) {
      throw new Error(
        "Unsupported: Cannot define an exponential function with `b`, the math to go from base to target amount becomes too hard."
      );
    }
  }

  toRawPrimitiveConfig(): any {
    return {
      exponentialCurveV0: {
        // @ts-ignore
        c: this.c,
        // @ts-ignore
        b: this.b,
        // @ts-ignore
        pow: this.pow,
        // @ts-ignore
        frac: this.frac,
      },
    };
  }

  toRawConfig(): CurveV0 {
    return {
      definition: {
        timeV0: {
          curves: [
            {
              // @ts-ignore
              offset: new BN(0),
              // @ts-ignore
              curve: this.toRawPrimitiveConfig(),
            },
          ],
        },
      },
    };
  }
}

/**
 * Curve configuration that allows the curve to change parameters at discrete time offsets from the go live date
 */
export class TimeCurveConfig implements ICurveConfig {
  curves: { curve: IPrimitiveCurve; offset: BN, buyTransitionFees: ITransitionFee | null, sellTransitionFees: ITransitionFee | null }[] = [];

  addCurve(timeOffset: number, curve: IPrimitiveCurve, buyTransitionFees: ITransitionFee | null = null, sellTransitionFees: ITransitionFee | null = null): TimeCurveConfig {
    if (this.curves.length == 0 && timeOffset != 0) {
      throw new Error("First time offset must be 0");
    }

    this.curves.push({
      curve,
      offset: new BN(timeOffset),
      buyTransitionFees,
      sellTransitionFees
    });

    return this;
  }

  toRawConfig(): CurveV0 {
    return {
      definition: {
        timeV0: {
          // @ts-ignore
          curves: this.curves.map(({ curve, offset, buyTransitionFees, sellTransitionFees }) => ({
            curve: curve.toRawPrimitiveConfig(),
            offset,
            buyTransitionFees,
            sellTransitionFees
          })),
        },
      },
    };
  }
}

export interface IInitializeCurveArgs {
  /** The configuration for the shape of curve */
  config: ICurveConfig;
  /** The payer to create this curve, defaults to provider.wallet */
  payer?: PublicKey;
}

export interface ICreateTokenBondingOutput {
  tokenBonding: PublicKey;
  targetMint: PublicKey;
  buyBaseRoyalties: PublicKey;
  buyTargetRoyalties: PublicKey;
  sellBaseRoyalties: PublicKey;
  sellTargetRoyalties: PublicKey;
  baseStorage: PublicKey;
}

export interface ICreateTokenBondingArgs {
  /** The payer to create this token bonding, defaults to provider.wallet */
  payer?: PublicKey;
  /** The shape of the bonding curve. Must be created using {@link SplTokenBonding.initializeCurve} */
  curve: PublicKey;
  /** The base mint that the `targetMint` will be priced in terms of. `baseMint` tokens will fill the bonding curve reserves */
  baseMint: PublicKey;
  /**
   * The mint this bonding curve will create on `buy`. If not provided, specify `targetMintDecimals` and it will create one for you
   *
   * It can be useful to pass the mint in if you're creating a bonding curve for an existing mint. Keep in mind,
   * the authority on this mint will need to be set to the token bonding pda
   */
  targetMint?: PublicKey; // If not provided, will create one with `targetMintDecimals`
  /**
   * **Default:** New generated keypair
   *
   * Pass in the keypair to use for the mint. Useful if you want a vanity keypair
   */
  targetMintKeypair?: anchor.web3.Keypair;
  /** If `targetMint` is not defined, will create a mint with this number of decimals */
  targetMintDecimals?: number;
  /**
   * Account to store royalties in terms of `baseMint` tokens when the {@link SplTokenBonding.buy} command is issued
   *
   * If not provided, will create an Associated Token Account with `buyBaseRoyaltiesOwner`
   */
  buyBaseRoyalties?: PublicKey;
  /** Only required when `buyBaseRoyalties` is undefined. The owner of the `buyBaseRoyalties` account. **Default:** `provider.wallet` */
  buyBaseRoyaltiesOwner?: PublicKey;
  /**
   * Account to store royalties in terms of `targetMint` tokens when the {@link SplTokenBonding.buy} command is issued
   *
   * If not provided, will create an Associated Token Account with `buyTargetRoyaltiesOwner`
   */
  buyTargetRoyalties?: PublicKey;
  /** Only required when `buyTargetRoyalties` is undefined. The owner of the `buyTargetRoyalties` account. **Default:** `provider.wallet` */
  buyTargetRoyaltiesOwner?: PublicKey;
  /**
   * Account to store royalties in terms of `baseMint` tokens when the {@link SplTokenBonding.sell} command is issued
   *
   * If not provided, will create an Associated Token Account with `sellBaseRoyaltiesOwner`
   */
  sellBaseRoyalties?: PublicKey;
  /** Only required when `sellBaseRoyalties` is undefined. The owner of the `sellBaseRoyalties` account. **Default:** `provider.wallet` */
  sellBaseRoyaltiesOwner?: PublicKey;
  /**
   * Account to store royalties in terms of `targetMint` tokens when the {@link SplTokenBonding.sell} command is issued
   *
   * If not provided, will create an Associated Token Account with `sellTargetRoyaltiesOwner`
   */
  sellTargetRoyalties?: PublicKey;
  /** Only required when `sellTargetRoyalties` is undefined. The owner of the `sellTargetRoyalties` account. **Default:** `provider.wallet` */
  sellTargetRoyaltiesOwner?: PublicKey;
  /**
   * General authority to change things like royalty percentages and freeze the curve. This is the least dangerous authority
   * **Default:** Wallet public key. Pass null to explicitly not set this authority.
   */
  generalAuthority?: PublicKey | null;
  /**
   * Authority to swap or change the reserve account. **This authority is dangerous. Use with care**
   *
   * From a trust perspective, this authority should almost always be held by another program that handles migrating bonding
   * curves, instead of by an individual.
   *
   * **Default:** null. You most likely don't need this permission, if it is being set you should do so explicitly.
   */
  reserveAuthority?: PublicKey | null;

  /**
   * Authority to swap or change the underlying curve. **This authority is dangerous. Use with care**
   *
   * From a trust perspective, this authority should almost always be held by another program that handles migrating bonding
   * curves, instead of by an individual.
   *
   * **Default:** null. You most likely don't need this permission, if it is being set you should do so explicitly.
   */
  curveAuthority?: PublicKey | null;
  /**
   * The reserves of the bonding curve. When {@link SplTokenBonding.buy} is called, `baseMint` tokens are stored here.
   * When {@link SplTokenBonding.sell} is called, `baseMint` tokens are returned to the callee from this account
   *
   * Optionally, this account can have an authority _not_ owned by the spl-token-bonding program. In this case, a bonding curve
   * is created with {@link SplTokenBonding.sell} disabled. This allows the bonding curve contract to be used like a
   * marketplace to sell a new token
   *
   * **Default:** creates this account for you, owned by the token bonding program
   */
  baseStorage?: PublicKey;
  /** Number from 0 to 100 */
  buyBaseRoyaltyPercentage: number;
  /** Number from 0 to 100 */
  buyTargetRoyaltyPercentage: number;
  /** Number from 0 to 100 */
  sellBaseRoyaltyPercentage: number;
  /** Number from 0 to 100 */
  sellTargetRoyaltyPercentage: number;
  /** Maximum `targetMint` tokens this bonding curve will mint before disabling {@link SplTokenBonding.buy}. **Default:** infinite */
  mintCap?: BN;
  /** Maximum `targetMint` tokens that can be purchased in a single call to {@link SplTokenBonding.buy}. Useful for limiting volume. **Default:** 0 */
  purchaseCap?: BN;
  /** The date this bonding curve will go live. Before this date, {@link SplTokenBonding.buy} and {@link SplTokenBonding.sell} are disabled. **Default:** 1 second ago */
  goLiveDate?: Date;
  /** The date this bonding curve will shut down. After this date, {@link SplTokenBonding.buy} and {@link SplTokenBonding.sell} are disabled. **Default:** null */
  freezeBuyDate?: Date;
  /** Should this bonding curve be frozen initially? It can be unfrozen using {@link SplTokenBonding.updateTokenBonding}. **Default:** false */
  buyFrozen?: boolean;
  /**
   * Multiple bonding curves can exist for a given target mint.
   * 0 is reserved for the one where the program owns mint authority and can mint new tokens. All other curves may exist as
   * markeplace curves
   */
  index?: number;
}

export interface IUpdateTokenBondingArgs {
  /** The bonding curve to update */
  tokenBonding: PublicKey;
  /** Number from 0 to 100. **Default:** current */
  buyBaseRoyaltyPercentage?: number;
  /** Number from 0 to 100. **Default:** current */
  buyTargetRoyaltyPercentage?: number;
  /** Number from 0 to 100. **Default:** current */
  sellBaseRoyaltyPercentage?: number;
  /** Number from 0 to 100. **Default:** current */
  sellTargetRoyaltyPercentage?: number;
  /** A new account to store royalties. **Default:** current */
  buyBaseRoyalties?: PublicKey;
  /** A new account to store royalties. **Default:** current */
  buyTargetRoyalties?: PublicKey;
  /** A new account to store royalties. **Default:** current */
  sellBaseRoyalties?: PublicKey;
  /** A new account to store royalties. **Default:** current */
  sellTargetRoyalties?: PublicKey;
  generalAuthority?: PublicKey | null;
  /** Should this bonding curve be frozen, disabling buy and sell? It can be unfrozen using {@link SplTokenBonding.updateTokenBonding}. **Default:** current */
  buyFrozen?: boolean;
}

export interface IBuyArgs {
  tokenBonding: PublicKey;
  /** The payer to run this transaction, defaults to provider.wallet */
  payer?: PublicKey;
  /** The source account to purchase with. **Default:** ata of `sourceAuthority` */
  source?: PublicKey;
  /** The source destination to purchase to. **Default:** ata of `sourceAuthority` */
  destination?: PublicKey;
  /** The wallet funding the purchase. **Default:** Provider wallet */
  sourceAuthority?: PublicKey;
  /** Must provide either base amount or desired target amount */
  desiredTargetAmount?: BN | number;
  baseAmount?: BN | number;
  /** Decimal number. max price will be (1 + slippage) * price_for_desired_target_amount */
  slippage: number;
}

export interface ISwapArgs {
  baseMint: PublicKey;
  targetMint: PublicKey;
  /** The payer to run this transaction, defaults to provider.wallet */
  payer?: PublicKey;
  /** The wallet funding the purchase. **Default:** Provider wallet */
  sourceAuthority?: PublicKey;
  /** The amount of baseMint to purchase with */
  baseAmount: BN | number;
  /** The slippage PER TRANSACTION */
  slippage: number;
  /** Optionally inject extra instructions before each trade. Usefull for adding txn fees */
  extraInstructions?: (args: {
    tokenBonding: ITokenBonding;
    isBuy: boolean;
    amount: BN;
  }) => Promise<InstructionResult<null>>;
}

export interface ISellArgs {
  tokenBonding: PublicKey;
  /** The payer to run this transaction, defaults to provider.wallet */
  payer?: PublicKey;
  source?: PublicKey /** `targetMint` source account to sell from. **Default:** ATA of sourceAuthority */;
  destination?: PublicKey /** `baseMint` destination for tokens from the reserve. **Default:** ATA of wallet */;
  sourceAuthority?: PublicKey /** **Default:** wallet */;
  targetAmount: BN | number /** The amount of `targetMint` tokens to sell. */;
  slippage: number /* Decimal number. max price will be (1 + slippage) * price_for_desired_target_amount */;
}

export interface IBuyBondingWrappedSolArgs {
  amount:
    | BN
    | number /** The amount of wSOL to buy. If a number, multiplied out to get lamports. If BN, it's lamports */;
  destination?: PublicKey /** The destination twSOL account. **Default:** ATA of owner */;
  source?: PublicKey /** The source of non-wrapped SOL */;
  payer?: PublicKey;
}

export interface ISellBondingWrappedSolArgs {
  amount:
    | BN
    | number /** The amount of wSOL to buy. If a number, multiplied out to get lamports. If BN, it's lamports */;
  source?: PublicKey /** The twSOL source account. **Default:** ATA of owner */;
  destination?: PublicKey /** The destination to send the actual SOL lamports. **Default:** provider wallet */;
  owner?: PublicKey /** The owner of the twSOL source account. **Default:** provider wallet */;
  payer?: PublicKey;
  all?: boolean /** Sell all and close this account? **Default:** false */;
}

/**
 * Unified token bonding interface wrapping the raw TokenBondingV0
 */
export interface ITokenBonding extends TokenBondingV0 {
  publicKey: PublicKey;
}

/**
 * Unified curve interface wrapping the raw CurveV0
 */
export interface ICurve extends CurveV0 {
  publicKey: PublicKey;
}

export class SplTokenBonding extends AnchorSdk<SplTokenBondingIDL> {
  state: ProgramStateV0 | undefined;

  static ID = new PublicKey("TBondmkCYxaPCKG4CHYfVTcwQ8on31xnJrPzk8F8WsS");

  static async init(
    provider: Provider,
    splTokenBondingProgramId: PublicKey = SplTokenBonding.ID
  ): Promise<SplTokenBonding> {
    const SplTokenBondingIDLJson = await anchor.Program.fetchIdl(
      splTokenBondingProgramId,
      provider
    );
    const splTokenBonding = new anchor.Program<SplTokenBondingIDL>(
      SplTokenBondingIDLJson as SplTokenBondingIDL,
      splTokenBondingProgramId,
      provider
    ) as anchor.Program<SplTokenBondingIDL>;

    return new this(provider, splTokenBonding);
  }

  constructor(provider: Provider, program: Program<SplTokenBondingIDL>) {
    super({ provider, program });
  }

  curveDecoder: TypedAccountParser<ICurve> = (pubkey, account) => {
    const coded = this.program.coder.accounts.decode<CurveV0>(
      "CurveV0",
      account.data
    );

    return {
      ...coded,
      publicKey: pubkey,
    };
  };

  tokenBondingDecoder: TypedAccountParser<ITokenBonding> = (
    pubkey,
    account
  ) => {
    const coded = this.program.coder.accounts.decode<ITokenBonding>(
      "TokenBondingV0",
      account.data
    );

    return {
      ...coded,
      publicKey: pubkey,
    };
  };

  getTokenBonding(tokenBondingKey: PublicKey): Promise<ITokenBonding | null> {
    return this.getAccount(tokenBondingKey, this.tokenBondingDecoder);
  }

  getCurve(curveKey: PublicKey): Promise<ICurve | null> {
    return this.getAccount(curveKey, this.curveDecoder);
  }

  /**
   * This is an admin function run once to initialize the smart contract.
   *
   * @returns Instructions needed to create sol storage
   */
  async initializeSolStorageInstructions({
    mintKeypair
  }: { mintKeypair: Keypair }): Promise<InstructionResult<null>> {
    const exists = await this.getState();
    if (exists) {
      return {
        output: null,
        instructions: [],
        signers: [],
      };
    }

    console.log("Sol storage does not exist, creating...");
    const [state, bumpSeed] = await PublicKey.findProgramAddress(
      [Buffer.from("state", "utf-8")],
      this.programId
    );
    const [solStorage, solStorageBumpSeed] = await PublicKey.findProgramAddress(
      [Buffer.from("sol-storage", "utf-8")],
      this.programId
    );
    const [wrappedSolAuthority, mintAuthorityBumpSeed] =
      await PublicKey.findProgramAddress(
        [Buffer.from("wrapped-sol-authority", "utf-8")],
        this.programId
      );

    const instructions: TransactionInstruction[] = [];
    const signers = [];
    signers.push(mintKeypair);

    instructions.push(
      ...[
        SystemProgram.createAccount({
          fromPubkey: this.wallet.publicKey,
          newAccountPubkey: mintKeypair.publicKey,
          space: 82,
          lamports:
            await this.provider.connection.getMinimumBalanceForRentExemption(
              82
            ),
          programId: TOKEN_PROGRAM_ID,
        }),
        Token.createInitMintInstruction(
          TOKEN_PROGRAM_ID,
          mintKeypair.publicKey,
          9,
          this.wallet.publicKey,
          wrappedSolAuthority
        ),
      ]
    );

    await createMetadata(
      new Data({
        name: "Token Bonding Wrapped SOL",
        symbol: "twSOL",
        uri: "",
        sellerFeeBasisPoints: 0,
        // @ts-ignore
        creators: null,
      }),
      this.wallet.publicKey.toBase58(),
      mintKeypair.publicKey.toBase58(),
      this.wallet.publicKey.toBase58(),
      instructions,
      this.wallet.publicKey.toBase58()
    );

    instructions.push(
      Token.createSetAuthorityInstruction(
        TOKEN_PROGRAM_ID,
        mintKeypair.publicKey,
        wrappedSolAuthority,
        "MintTokens",
        this.wallet.publicKey,
        []
      )
    );

    instructions.push(
      await this.instruction.initializeSolStorageV0(
        {
          solStorageBumpSeed,
          bumpSeed,
          mintAuthorityBumpSeed,
        },
        {
          accounts: {
            state,
            payer: this.wallet.publicKey,
            solStorage,
            mintAuthority: wrappedSolAuthority,
            wrappedSolMint: mintKeypair.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          },
        }
      )
    );

    return {
      instructions,
      signers,
      output: null,
    };
  }

  /**
   * Admin command run once to initialize the smart contract
   */
  initializeSolStorage({
    mintKeypair
  }: { mintKeypair: Keypair }): Promise<null> {
    return this.execute(this.initializeSolStorageInstructions({ mintKeypair }));
  }

  /**
   * Create a curve shape for use in a TokenBonding instance
   *
   * @param param0
   * @returns
   */
  async initializeCurveInstructions({
    payer = this.wallet.publicKey,
    config: curveConfig,
  }: IInitializeCurveArgs): Promise<InstructionResult<{ curve: PublicKey }>> {
    const curve = curveConfig.toRawConfig();
    const curveKeypair = anchor.web3.Keypair.generate();
    return {
      output: {
        curve: curveKeypair.publicKey,
      },
      signers: [curveKeypair],
      instructions: [
        SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: curveKeypair.publicKey,
          space: 500,
          lamports:
            await this.provider.connection.getMinimumBalanceForRentExemption(
              500
            ),
          programId: this.programId,
        }),
        await this.instruction.createCurveV0(curve, {
          accounts: {
            payer,
            curve: curveKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          },
        }),
      ],
    };
  }

  /**
   * See {@link initializeCurve}
   * @param args
   * @returns
   */
  async initializeCurve(args: IInitializeCurveArgs): Promise<PublicKey> {
    return (await this.execute(this.initializeCurveInstructions(args))).curve;
  }

  /**
   * Get the PDA key of a TokenBonding given the target mint and index
   *
   * `index` = 0 is the default bonding curve that can mint `targetMint`. All other curves are curves that allow burning of `targetMint` for some different base.
   *
   * @param targetMint
   * @param index
   * @returns
   */
  static async tokenBondingKey(
    targetMint: PublicKey,
    index: number = 0,
    programId: PublicKey = SplTokenBonding.ID
  ): Promise<[PublicKey, number]> {
    const pad = Buffer.alloc(2);
    new BN(index, 16, "le").toBuffer().copy(pad);
    return PublicKey.findProgramAddress(
      [Buffer.from("token-bonding", "utf-8"), targetMint!.toBuffer(), pad],
      programId
    );
  }

  /**
   * Create a bonding curve
   *
   * @param param0
   * @returns
   */
  async createTokenBondingInstructions({
    generalAuthority = this.wallet.publicKey,
    curveAuthority = null,
    reserveAuthority = null,
    payer = this.wallet.publicKey,
    curve,
    baseMint,
    targetMint,
    baseStorage,
    buyBaseRoyalties,
    buyBaseRoyaltiesOwner = this.wallet.publicKey,
    buyTargetRoyalties,
    buyTargetRoyaltiesOwner = this.wallet.publicKey,
    sellBaseRoyalties,
    sellBaseRoyaltiesOwner = this.wallet.publicKey,
    sellTargetRoyalties,
    sellTargetRoyaltiesOwner = this.wallet.publicKey,
    buyBaseRoyaltyPercentage,
    buyTargetRoyaltyPercentage,
    sellBaseRoyaltyPercentage,
    sellTargetRoyaltyPercentage,
    mintCap,
    purchaseCap,
    goLiveDate = new Date(new Date().valueOf() - 10000), // 10 secs ago
    freezeBuyDate,
    targetMintDecimals,
    targetMintKeypair = Keypair.generate(),
    buyFrozen = false,
    index,
  }: ICreateTokenBondingArgs): Promise<
    InstructionResult<ICreateTokenBondingOutput>
  > {
    if (!targetMint) {
      if (sellTargetRoyalties || buyTargetRoyalties) {
        throw new Error(
          "Cannot define target royalties if mint is not defined"
        );
      }

      if (typeof targetMintDecimals == "undefined") {
        throw new Error("Cannot define mint without decimals ");
      }
    }
    const provider = this.provider;
    const state = (await this.getState())!;
    if (baseMint.equals(NATIVE_MINT)) {
      baseMint = state.wrappedSolMint;
    }

    const instructions: TransactionInstruction[] = [];
    const signers = [];
    let shouldCreateMint = false;
    if (!targetMint) {
      signers.push(targetMintKeypair);
      targetMint = targetMintKeypair.publicKey;
      shouldCreateMint = true;
    }

    // Find the proper bonding index to use that isn't taken.
    let indexToUse = index || 0;
    const getTokenBonding: () => Promise<[PublicKey, Number]> = () => {
      return SplTokenBonding.tokenBondingKey(targetMint!, indexToUse);
    };
    const getTokenBondingAccount = async () => {
      return this.provider.connection.getAccountInfo(
        (await getTokenBonding())[0]
      );
    };
    if (!index) {
      // Find an empty voucher account
      while (await getTokenBondingAccount()) {
        indexToUse++;
      }
    } else {
      indexToUse = index;
    }

    const [tokenBonding, bumpSeed] = await SplTokenBonding.tokenBondingKey(
      targetMint!,
      indexToUse
    );

    if (shouldCreateMint) {
      instructions.push(
        ...(await createMintInstructions(
          provider,
          tokenBonding,
          targetMint,
          targetMintDecimals
        ))
      );
    }

    // This is a buy/sell bonding curve. Create the program owned base storage account
    if (!baseStorage) {
      const baseStorageKeypair = anchor.web3.Keypair.generate();
      signers.push(baseStorageKeypair);
      baseStorage = baseStorageKeypair.publicKey;

      instructions.push(
        SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: baseStorage!,
          space: AccountLayout.span,
          programId: TOKEN_PROGRAM_ID,
          lamports:
            await this.provider.connection.getMinimumBalanceForRentExemption(
              AccountLayout.span
            ),
        }),
        Token.createInitAccountInstruction(
          TOKEN_PROGRAM_ID,
          baseMint,
          baseStorage,
          tokenBonding
        )
      );
    }

    let createdAccts: Set<string> = new Set();
    if (!buyTargetRoyalties) {
      buyTargetRoyalties = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        targetMint,
        buyTargetRoyaltiesOwner,
        true
      );

      // If sell target royalties are undefined, we'll do this in the next step
      if (
        !createdAccts.has(buyTargetRoyalties.toBase58()) &&
        !(await this.accountExists(buyTargetRoyalties))
      ) {
        console.log("Creating buy target royalties...");
        instructions.push(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            targetMint,
            buyTargetRoyalties,
            buyTargetRoyaltiesOwner,
            payer
          )
        );
        createdAccts.add(buyTargetRoyalties.toBase58());
      }
    }

    if (!sellTargetRoyalties) {
      sellTargetRoyalties = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        targetMint,
        sellTargetRoyaltiesOwner,
        true
      );

      if (
        !createdAccts.has(sellTargetRoyalties.toBase58()) &&
        !(await this.accountExists(sellTargetRoyalties))
      ) {
        console.log("Creating sell target royalties...");
        instructions.push(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            targetMint,
            sellTargetRoyalties,
            sellTargetRoyaltiesOwner,
            payer
          )
        );
        createdAccts.add(buyTargetRoyalties.toBase58());
      }
    }

    if (!buyBaseRoyalties) {
      buyBaseRoyalties = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        baseMint,
        buyBaseRoyaltiesOwner,
        true
      );

      // If sell base royalties are undefined, we'll do this in the next step
      if (
        !createdAccts.has(buyBaseRoyalties.toBase58()) &&
        !(await this.accountExists(buyBaseRoyalties))
      ) {
        console.log("Creating base royalties...");
        instructions.push(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            baseMint,
            buyBaseRoyalties,
            buyBaseRoyaltiesOwner,
            payer
          )
        );
        createdAccts.add(buyBaseRoyalties.toBase58());
      }
    }

    if (!sellBaseRoyalties) {
      sellBaseRoyalties = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        baseMint,
        sellBaseRoyaltiesOwner,
        true
      );

      if (
        !createdAccts.has(sellBaseRoyalties.toBase58()) &&
        !(await this.accountExists(sellBaseRoyalties))
      ) {
        console.log("Creating base royalties...");
        instructions.push(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            baseMint,
            sellBaseRoyalties,
            sellBaseRoyaltiesOwner,
            payer
          )
        );
        createdAccts.add(sellBaseRoyalties.toBase58());
      }
    }

    instructions.push(
      await this.instruction.initializeTokenBondingV0(
        {
          index: indexToUse,
          goLiveUnixTime: new BN(Math.floor(goLiveDate.valueOf() / 1000)),
          freezeBuyUnixTime: freezeBuyDate
            ? new BN(Math.floor(freezeBuyDate.valueOf() / 1000))
            : null,
          buyBaseRoyaltyPercentage: percent(buyBaseRoyaltyPercentage) || 0,
          buyTargetRoyaltyPercentage: percent(buyTargetRoyaltyPercentage) || 0,
          sellBaseRoyaltyPercentage: percent(sellBaseRoyaltyPercentage) || 0,
          sellTargetRoyaltyPercentage:
            percent(sellTargetRoyaltyPercentage) || 0,
          mintCap: mintCap || null,
          purchaseCap: purchaseCap || null,
          generalAuthority,
          curveAuthority,
          reserveAuthority,
          bumpSeed,
          buyFrozen,
        },
        {
          accounts: {
            payer: payer,
            curve,
            tokenBonding,
            baseMint,
            targetMint: targetMint,
            baseStorage,
            buyBaseRoyalties,
            buyTargetRoyalties,
            sellBaseRoyalties,
            sellTargetRoyalties,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            clock: SYSVAR_CLOCK_PUBKEY,
          },
        }
      )
    );

    return {
      output: {
        tokenBonding,
        targetMint,
        buyBaseRoyalties,
        buyTargetRoyalties,
        sellBaseRoyalties,
        sellTargetRoyalties,
        baseStorage,
      },
      instructions,
      signers,
    };
  }

  /**
   * General utility function to check if an account exists
   * @param account
   * @returns
   */
  async accountExists(account: anchor.web3.PublicKey): Promise<boolean> {
    return Boolean(await this.provider.connection.getAccountInfo(account));
  }

  /**
   * Runs {@link `createTokenBondingInstructions`}
   *
   * @param args
   * @returns
   */
  createTokenBonding(
    args: ICreateTokenBondingArgs
  ): Promise<ICreateTokenBondingOutput> {
    return this.execute(this.createTokenBondingInstructions(args), args.payer);
  }

  /**
   * Update a bonding curve.
   *
   * @param param0
   * @returns
   */
  async updateTokenBondingInstructions({
    tokenBonding,
    buyBaseRoyaltyPercentage,
    buyTargetRoyaltyPercentage,
    sellBaseRoyaltyPercentage,
    sellTargetRoyaltyPercentage,
    buyBaseRoyalties,
    buyTargetRoyalties,
    sellBaseRoyalties,
    sellTargetRoyalties,
    generalAuthority,
    buyFrozen,
  }: IUpdateTokenBondingArgs): Promise<InstructionResult<null>> {
    const tokenBondingAcct = (await this.getTokenBonding(tokenBonding))!;
    if (!tokenBondingAcct.generalAuthority) {
      throw new Error(
        "Cannot update a token bonding account that has no authority"
      );
    }

    const args: IdlTypes<SplTokenBondingIDL>["UpdateTokenBondingV0Args"] = {
      buyBaseRoyaltyPercentage:
        percent(buyBaseRoyaltyPercentage) ||
        tokenBondingAcct.buyBaseRoyaltyPercentage,
      buyTargetRoyaltyPercentage:
        percent(buyTargetRoyaltyPercentage) ||
        tokenBondingAcct.buyTargetRoyaltyPercentage,
      sellBaseRoyaltyPercentage:
        percent(sellBaseRoyaltyPercentage) ||
        tokenBondingAcct.sellBaseRoyaltyPercentage,
      sellTargetRoyaltyPercentage:
        percent(sellTargetRoyaltyPercentage) ||
        tokenBondingAcct.sellTargetRoyaltyPercentage,
      generalAuthority:
        generalAuthority === null
          ? null
          : generalAuthority! ||
            (tokenBondingAcct.generalAuthority as PublicKey),
      buyFrozen:
        typeof buyFrozen === "undefined"
          ? (tokenBondingAcct.buyFrozen as boolean)
          : buyFrozen,
    };

    return {
      output: null,
      signers: [],
      instructions: [
        await this.instruction.updateTokenBondingV0(args, {
          accounts: {
            tokenBonding,
            generalAuthority: (tokenBondingAcct.generalAuthority as PublicKey)!,
            baseMint: tokenBondingAcct.baseMint,
            targetMint: tokenBondingAcct.targetMint,
            buyTargetRoyalties:
              buyTargetRoyalties || tokenBondingAcct.buyTargetRoyalties,
            buyBaseRoyalties:
              buyBaseRoyalties || tokenBondingAcct.buyBaseRoyalties,
            sellTargetRoyalties:
              sellTargetRoyalties || tokenBondingAcct.sellTargetRoyalties,
            sellBaseRoyalties:
              sellBaseRoyalties || tokenBondingAcct.sellBaseRoyalties,
          },
        }),
      ],
    };
  }

  /**
   * Runs {@link updateTokenBonding}
   * @param args
   */
  async updateTokenBonding(args: IUpdateTokenBondingArgs): Promise<void> {
    await this.execute(this.updateTokenBondingInstructions(args));
  }

  /**
   * Instructions to buy twSOL from normal SOL.
   *
   * We wrap SOL so that the bonding contract isn't soaking up a bunch o SOL and damaging the security of the network.
   * The plan is to create a DAO for Strata that will govern what happens with this SOL.
   *
   * @param param0
   * @returns
   */
  async buyBondingWrappedSolInstructions({
    payer = this.wallet.publicKey,
    destination,
    source = this.wallet.publicKey,
    amount,
  }: IBuyBondingWrappedSolArgs): Promise<
    InstructionResult<{ destination: PublicKey }>
  > {
    const state = (await this.getState())!;
    const stateAddress = (
      await PublicKey.findProgramAddress(
        [Buffer.from("state", "utf-8")],
        this.programId
      )
    )[0];
    const mintAuthority = (
      await PublicKey.findProgramAddress(
        [Buffer.from("wrapped-sol-authority", "utf-8")],
        this.programId
      )
    )[0];
    const mint = await getMintInfo(this.provider, state.wrappedSolMint);

    let usedAta = false;
    if (!destination) {
      destination = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        state.wrappedSolMint,
        source
      );
      usedAta = true;
    }
    const instructions = [];

    if (usedAta && !(await this.accountExists(destination))) {
      instructions.push(
        Token.createAssociatedTokenAccountInstruction(
          ASSOCIATED_TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          state.wrappedSolMint,
          destination,
          source,
          payer
        )
      );
    }

    instructions.push(
      await this.instruction.buyWrappedSolV0(
        {
          amount: toBN(amount, mint),
        },
        {
          accounts: {
            state: stateAddress,
            wrappedSolMint: state.wrappedSolMint,
            mintAuthority: mintAuthority,
            solStorage: state.solStorage,
            source,
            destination,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          },
        }
      )
    );

    return {
      signers: [],
      output: {
        destination,
      },
      instructions,
    };
  }

  /**
   * Invoke `buyBondingWrappedSol` instructions
   * @param args
   * @returns
   */
  buyBondingWrappedSol(
    args: IBuyBondingWrappedSolArgs
  ): Promise<{ destination: PublicKey }> {
    return this.execute(
      this.buyBondingWrappedSolInstructions(args),
      args.payer
    );
  }

  /**
   * Instructions to sell twSOL back into normal SOL.
   *
   * @param param0
   * @returns
   */
  async sellBondingWrappedSolInstructions({
    source,
    owner = this.wallet.publicKey,
    destination = this.wallet.publicKey,
    amount,
    all = false,
  }: ISellBondingWrappedSolArgs): Promise<InstructionResult<null>> {
    const state = (await this.getState())!;
    const stateAddress = (
      await PublicKey.findProgramAddress(
        [Buffer.from("state", "utf-8")],
        this.programId
      )
    )[0];
    const mint = await getMintInfo(this.provider, state.wrappedSolMint);

    if (!source) {
      source = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        state.wrappedSolMint,
        owner
      );
    }

    const instructions = [];

    instructions.push(
      await this.instruction.sellWrappedSolV0(
        {
          amount: toBN(amount, mint),
          all,
        },
        {
          accounts: {
            state: stateAddress,
            wrappedSolMint: state.wrappedSolMint,
            solStorage: state.solStorage,
            source,
            owner,
            destination,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          },
        }
      )
    );

    if (all) {
      instructions.push(
        Token.createCloseAccountInstruction(
          TOKEN_PROGRAM_ID,
          source,
          destination,
          owner,
          []
        )
      );
    }

    return {
      signers: [],
      output: null,
      instructions,
    };
  }

  /**
   * Execute `sellBondingWrappedSolInstructions`
   * @param args
   * @returns
   */
  async sellBondingWrappedSol(args: ISellBondingWrappedSolArgs): Promise<null> {
    return this.execute(
      this.sellBondingWrappedSolInstructions(args),
      args.payer
    );
  }

  /**
   * Create a temporary account with `amount` twSOL, the token bonding wrapped sol mint.
   *
   * @param param0
   * @returns
   */
  async createTemporaryWSolAccount({
    payer,
    owner,
    amount,
  }: {
    owner: PublicKey;
    payer: PublicKey;
    amount: number;
  }): Promise<{
    signer: Keypair;
    firstInstructions: TransactionInstruction[];
    lastInstructions: TransactionInstruction[];
  }> {
    const state = (await this.getState())!;
    const mint = await getMintInfo(this.provider, state.wrappedSolMint);

    // Create a new account
    const newAccount = anchor.web3.Keypair.generate();
    const balanceNeeded = await Token.getMinBalanceRentForExemptAccount(
      this.provider.connection
    );
    return {
      firstInstructions: [
        SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: newAccount.publicKey,
          lamports: balanceNeeded,
          space: AccountLayout.span,
          programId: TOKEN_PROGRAM_ID,
        }),
        Token.createInitAccountInstruction(
          TOKEN_PROGRAM_ID,
          state.wrappedSolMint,
          newAccount.publicKey,
          owner
        ),
        ...(
          await this.buyBondingWrappedSolInstructions({
            destination: newAccount.publicKey,
            amount: toBN(amount, mint).add(new BN(1)), // In case of rounding errors,
            source: owner,
          })
        ).instructions,
      ],
      lastInstructions: (
        await this.sellBondingWrappedSolInstructions({
          source: newAccount.publicKey,
          owner,
          all: true,
          amount: toBN(amount, mint),
        })
      ).instructions,
      signer: newAccount,
    };
  }

  /**
   * Issue a command to buy `targetMint` tokens with `baseMint` tokens.
   *
   * @param param0
   * @returns
   */
  async buyInstructions({
    tokenBonding,
    source,
    sourceAuthority = this.wallet.publicKey,
    destination,
    desiredTargetAmount,
    baseAmount,
    slippage,
    payer = this.wallet.publicKey,
  }: IBuyArgs): Promise<InstructionResult<null>> {
    const state = (await this.getState())!;
    const tokenBondingAcct = (await this.getTokenBonding(tokenBonding))!;
    // @ts-ignore
    const targetMint = await getMintInfo(
      this.provider,
      tokenBondingAcct.targetMint
    );
    const baseMint = await getMintInfo(
      this.provider,
      tokenBondingAcct.baseMint
    );
    const baseStorage = await getTokenAccount(
      this.provider,
      tokenBondingAcct.baseStorage
    );
    // @ts-ignore
    const curve = await this.getPricingCurve(
      tokenBondingAcct.curve,
      baseStorage,
      baseMint,
      targetMint,
      tokenBondingAcct.goLiveUnixTime.toNumber()
    );

    const instructions = [];
    const signers = [];
    if (!destination) {
      destination = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        tokenBondingAcct.targetMint,
        sourceAuthority
      );

      if (!(await this.accountExists(destination))) {
        console.log("Creating target account");
        instructions.push(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            tokenBondingAcct.targetMint,
            destination,
            sourceAuthority,
            payer
          )
        );
      }
    }

    let buyTargetAmount = null;
    let buyWithBase = null;
    let rootEstimates = null;
    let maxPrice: number = 0;
    if (desiredTargetAmount) {
      const desiredTargetAmountNum = toNumber(desiredTargetAmount, targetMint);
      const neededAmount =
        desiredTargetAmountNum *
        (1 / (1 - asDecimal(tokenBondingAcct.buyTargetRoyaltyPercentage)));
      const curveAmount = curve.buyTargetAmount(
        desiredTargetAmountNum,
        tokenBondingAcct.buyBaseRoyaltyPercentage,
        tokenBondingAcct.buyTargetRoyaltyPercentage
      );
      maxPrice = curveAmount * (1 + slippage);
      rootEstimates = curve.buyTargetAmountRootEstimates(
        desiredTargetAmountNum,
        tokenBondingAcct.buyTargetRoyaltyPercentage
      );

      buyTargetAmount = {
        targetAmount: new BN(
          Math.floor(neededAmount * Math.pow(10, targetMint.decimals))
        ),
        maximumPrice: toBN(maxPrice, baseMint),
      };
    }

    if (baseAmount) {
      const baseAmountNum = toNumber(baseAmount, baseMint);
      const min =
        curve.buyWithBaseAmount(
          baseAmountNum,
          tokenBondingAcct.buyBaseRoyaltyPercentage,
          tokenBondingAcct.buyTargetRoyaltyPercentage
        ) *
        (1 - slippage);
      maxPrice = baseAmountNum;
      rootEstimates = curve.buyWithBaseRootEstimates(
        baseAmountNum,
        tokenBondingAcct.buyBaseRoyaltyPercentage
      );

      buyWithBase = {
        baseAmount: toBN(baseAmount, baseMint),
        minimumTargetAmount: new BN(
          Math.ceil(Math.ceil(min * Math.pow(10, targetMint.decimals) * (1 - slippage)))
        ),
      };
    }

    let lastInstructions = [];
    if (!source) {
      if (tokenBondingAcct.baseMint.equals(state.wrappedSolMint)) {
        const {
          signer,
          firstInstructions,
          lastInstructions: lastInstrs,
        } = await this.createTemporaryWSolAccount({
          payer: payer,
          owner: sourceAuthority,
          amount: maxPrice!,
        });
        source = signer.publicKey;
        signers.push(signer);
        instructions.push(...firstInstructions);
        lastInstructions.push(...lastInstrs);
      } else {
        source = await Token.getAssociatedTokenAddress(
          ASSOCIATED_TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          tokenBondingAcct.baseMint,
          sourceAuthority
        );

        if (!(await this.accountExists(source))) {
          throw new Error("Source account does not exist");
        }
      }
    }

    const args: IdlTypes<SplTokenBondingIDL>["BuyV0Args"] = {
      // @ts-ignore
      buyTargetAmount,
      // @ts-ignore
      buyWithBase,
      rootEstimates: rootEstimates?.map(toU128),
    };
    const accounts = {
      accounts: {
        tokenBonding,
        // @ts-ignore
        curve: tokenBondingAcct.curve,
        baseMint: tokenBondingAcct.baseMint,
        targetMint: tokenBondingAcct.targetMint,
        baseStorage: tokenBondingAcct.baseStorage,
        buyBaseRoyalties: tokenBondingAcct.buyBaseRoyalties,
        buyTargetRoyalties: tokenBondingAcct.buyTargetRoyalties,
        source,
        sourceAuthority,
        destination,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: SYSVAR_CLOCK_PUBKEY,
      },
    };
    instructions.push(await this.instruction.buyV0(args, accounts));
    instructions.push(...lastInstructions);

    return {
      output: null,
      signers,
      instructions,
    };
  }

  /**
   * Runs {@link buy}
   * @param args
   */
  async buy(args: IBuyArgs): Promise<void> {
    await this.execute(this.buyInstructions(args), args.payer);
  }

  async getTokenAccountBalance(
    account: PublicKey,
    commitment: Commitment = "confirmed"
  ): Promise<BN> {
    const acct = await this.provider.connection.getAccountInfo(
      account,
      commitment
    );
    if (acct) {
      return u64.fromBuffer(AccountLayout.decode(acct.data).amount);
    }

    return new BN(0);
  }

  /**
   * Swap from any base mint to any target mint that are both on a shared link of bonding curves.
   * Intelligently traverses using either buy or sell, executing multiple txns to either sell baseAmount
   * or buy with baseAmount
   *
   * @param param0
   */
  async swap({
    payer = this.wallet.publicKey,
    sourceAuthority = this.wallet.publicKey,
    baseMint,
    targetMint,
    baseAmount,
    slippage,
    extraInstructions = () =>
      Promise.resolve({
        instructions: [],
        signers: [],
        output: null,
      }),
  }: ISwapArgs): Promise<{ targetAmount: number }> {
    const hierarchyFromTarget = await this.getBondingHierarchy(
      (
        await SplTokenBonding.tokenBondingKey(targetMint)
      )[0],
      baseMint
    );
    const hierarchyFromBase = await this.getBondingHierarchy(
      (
        await SplTokenBonding.tokenBondingKey(baseMint)
      )[0],
      targetMint
    );
    const hierarchy = [hierarchyFromTarget, hierarchyFromBase].find(
      (hierarchy) => hierarchy?.contains(baseMint, targetMint)
    );
    if (!hierarchy) {
      throw new Error(
        `No bonding curve hierarchies found for base or target that contain both ${baseMint.toBase58()} and ${targetMint.toBase58()}`
      );
    }
    const isBuy = hierarchy.tokenBonding.targetMint.equals(targetMint);
    const arrHierarchy = hierarchy?.toArray() || [];

    const baseMintInfo = await getMintInfo(this.provider, baseMint);

    let currAmount = toBN(baseAmount, baseMintInfo);
    for (const subHierarchy of isBuy ? arrHierarchy.reverse() : arrHierarchy) {
      const tokenBonding = subHierarchy.tokenBonding;
      const baseIsSol = tokenBonding.baseMint.equals(
        (await this.getState())?.wrappedSolMint!
      );
      const ata = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        isBuy ? tokenBonding.targetMint : tokenBonding.baseMint,
        sourceAuthority
      );

      const getBalance = async (): Promise<BN> => {
        if (!isBuy && baseIsSol) {
          return new BN(
            (
              await this.provider.connection.getAccountInfo(
                sourceAuthority,
                "single"
              )
            )?.lamports || 0
          );
        } else {
          return this.getTokenAccountBalance(ata, "single");
        }
      };
      const preBalance = await getBalance();

      let instructions: TransactionInstruction[];
      let signers: Signer[];
      if (isBuy) {
        console.log(
          `Actually doing ${tokenBonding.baseMint.toBase58()} to ${tokenBonding.targetMint.toBase58()}`
        );
        ({ instructions, signers } = await this.buyInstructions({
          payer,
          sourceAuthority,
          baseAmount: currAmount,
          tokenBonding: tokenBonding.publicKey,
          slippage,
        }));
      } else {
        console.log(
          `SELL doing ${tokenBonding.baseMint.toBase58()} to ${tokenBonding.targetMint.toBase58()}`
        );
        ({ instructions, signers } = await this.sellInstructions({
          payer,
          sourceAuthority,
          targetAmount: currAmount,
          tokenBonding: tokenBonding.publicKey,
          slippage,
        }));
      }

      const { instructions: extraInstrs, signers: extaSigners } =
        await extraInstructions({
          tokenBonding,
          amount: currAmount,
          isBuy,
        });
      await this.sendInstructions(
        [...instructions, ...extraInstrs],
        [...signers, ...extaSigners],
        payer
      );

      async function newBalance(tries: number = 0): Promise<BN> {
        if (tries >= 4) {
          return new BN(0);
        }
        let postBalance = await getBalance();
        // Sometimes it can take a bit for Solana to catch up
        // Wait and see if the balance truly hasn't changed.
        if (postBalance.eq(preBalance)) {
          console.log(
            "No balance change detected while swapping, trying again",
            tries
          );
          await sleep(5000);
          return newBalance(tries + 1);
        }

        return postBalance;
      }

      const postBalance = await newBalance();

      currAmount = postBalance!.sub(preBalance || new BN(0));
      // Fees, or something else caused the balance to be negative. Just report the change
      // and quit
      if (currAmount.eq(new BN(0))) {
        const targetMintInfo = await getMintInfo(
          this.provider,
          isBuy ? tokenBonding.targetMint : tokenBonding.baseMint
        );
        return {
          targetAmount:
            toNumber(postBalance!, targetMintInfo) -
            toNumber(preBalance, targetMintInfo),
        };
      }
    }

    const targetMintInfo = await getMintInfo(this.provider, targetMint);
    return {
      targetAmount: toNumber(currAmount, targetMintInfo),
    };
  }

  async getState(): Promise<ProgramStateV0 | null> {
    if (this.state) {
      return this.state;
    }

    const stateAddress = (
      await PublicKey.findProgramAddress(
        [Buffer.from("state", "utf-8")],
        this.programId
      )
    )[0];
    return this.account.programStateV0.fetchNullable(stateAddress);
  }

  /**
   * Instructions to burn `targetMint` tokens in exchange for `baseMint` tokens
   *
   * @param param0
   * @returns
   */
  async sellInstructions({
    tokenBonding,
    source,
    sourceAuthority = this.wallet.publicKey,
    destination,
    targetAmount,
    slippage,
    payer = this.wallet.publicKey,
  }: ISellArgs): Promise<InstructionResult<null>> {
    const state = (await this.getState())!;
    const tokenBondingAcct = (await this.getTokenBonding(tokenBonding))!;
    if (tokenBondingAcct.sellFrozen) {
      throw new Error("Sell is frozen on this bonding curve");
    }

    // @ts-ignore
    const targetMint = await getMintInfo(
      this.provider,
      tokenBondingAcct.targetMint
    );
    const baseMint = await getMintInfo(
      this.provider,
      tokenBondingAcct.baseMint
    );
    const baseStorage = await getTokenAccount(
      this.provider,
      tokenBondingAcct.baseStorage
    );
    // @ts-ignore
    const curve = await this.getPricingCurve(
      tokenBondingAcct.curve,
      baseStorage,
      baseMint,
      targetMint,
      tokenBondingAcct.goLiveUnixTime.toNumber()
    );

    const instructions = [];
    const signers = [];
    if (!source) {
      source = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        tokenBondingAcct.targetMint,
        sourceAuthority
      );

      if (!(await this.accountExists(source))) {
        throw new Error("Source account does not exist");
      }
    }

    const lastInstructions = [];
    if (!destination) {
      if (tokenBondingAcct.baseMint.equals(state.wrappedSolMint)) {
        const {
          signer,
          firstInstructions,
          lastInstructions: lastInstrs,
        } = await this.createTemporaryWSolAccount({
          payer,
          owner: sourceAuthority,
          amount: 0,
        });
        destination = signer.publicKey;
        signers.push(signer);
        instructions.push(...firstInstructions);
        lastInstructions.push(...lastInstrs);
      } else {
        destination = await Token.getAssociatedTokenAddress(
          ASSOCIATED_TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          tokenBondingAcct.baseMint,
          sourceAuthority
        );

        if (!(await this.accountExists(destination))) {
          console.log("Creating base account");
          instructions.push(
            Token.createAssociatedTokenAccountInstruction(
              ASSOCIATED_TOKEN_PROGRAM_ID,
              TOKEN_PROGRAM_ID,
              tokenBondingAcct.baseMint,
              destination,
              sourceAuthority,
              payer
            )
          );
        }
      }
    }

    const targetAmountNum = toNumber(targetAmount, targetMint);
    const reclaimedAmount = curve.sellTargetAmount(
      targetAmountNum,
      tokenBondingAcct.sellBaseRoyaltyPercentage,
      tokenBondingAcct.sellTargetRoyaltyPercentage
    );
    const minPrice = Math.ceil(
      reclaimedAmount * (1 - slippage) * Math.pow(10, baseMint.decimals)
    );
    const args: IdlTypes<SplTokenBondingIDL>["SellV0Args"] = {
      targetAmount: toBN(targetAmount, targetMint),
      minimumPrice: new BN(minPrice),
      rootEstimates: curve
        .buyTargetAmountRootEstimates(
          -targetAmountNum *
            (1 - asDecimal(tokenBondingAcct.sellTargetRoyaltyPercentage)),
          0
        )
        .map(toU128),
    };
    const accounts = {
      accounts: {
        tokenBonding,
        // @ts-ignore
        curve: tokenBondingAcct.curve,
        baseMint: tokenBondingAcct.baseMint,
        targetMint: tokenBondingAcct.targetMint,
        baseStorage: tokenBondingAcct.baseStorage,
        sellBaseRoyalties: tokenBondingAcct.sellBaseRoyalties,
        sellTargetRoyalties: tokenBondingAcct.sellTargetRoyalties,
        source,
        sourceAuthority,
        destination,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: SYSVAR_CLOCK_PUBKEY,
      },
    };
    instructions.push(await this.instruction.sellV0(args, accounts));
    instructions.push(...lastInstructions);

    return {
      output: null,
      signers,
      instructions,
    };
  }

  /**
   * Runs {@link sell}
   * @param args
   */
  async sell(args: ISellArgs): Promise<void> {
    await this.execute(this.sellInstructions(args), args.payer);
  }

  /**
   * Get a class capable of displaying pricing information or this token bonding at its current reserve and supply
   *
   * @param tokenBonding
   * @returns
   */
  async getBondingPricingCurve(
    tokenBonding: PublicKey
  ): Promise<IPricingCurve> {
    const tokenBondingAcct = (await this.getTokenBonding(tokenBonding))!;
    const targetMint = await getMintInfo(
      this.provider,
      tokenBondingAcct.targetMint
    );
    const baseMint = await getMintInfo(
      this.provider,
      tokenBondingAcct.baseMint
    );
    const baseStorage = await getTokenAccount(
      this.provider,
      tokenBondingAcct.baseStorage
    );

    return this.getPricingCurve(
      tokenBondingAcct.curve,
      baseStorage,
      baseMint,
      targetMint,
      tokenBondingAcct.goLiveUnixTime.toNumber()
    );
  }

  /**
   * Given some reserves and supply, get a pricing model for a curve at `key`.
   *
   * @param key
   * @param baseStorage
   * @param baseMint
   * @param targetMint
   * @returns
   */
  async getPricingCurve(
    key: PublicKey,
    baseStorage: AccountInfo,
    baseMint: MintInfo,
    targetMint: MintInfo,
    goLiveUnixTime: number
  ): Promise<IPricingCurve> {
    const curve = await this.getCurve(key);
    // @ts-ignore
    return fromCurve(curve, baseStorage, baseMint, targetMint, goLiveUnixTime );
  }

  async getPricing(
    tokenBondingKey: PublicKey | undefined
  ): Promise<BondingPricing | undefined> {
    const hierarchy = await this.getBondingHierarchy(tokenBondingKey);
    if (hierarchy) {
      return new BondingPricing({
        hierarchy: hierarchy,
      });
    }
  }

  /**
   * Fetch the token bonding curve and all of its direct ancestors
   *
   * @param tokenBondingKey
   * @returns
   */
  async getBondingHierarchy(
    tokenBondingKey: PublicKey | undefined,
    stopAtMint?: PublicKey | undefined
  ): Promise<BondingHierarchy | undefined> {
    const wrappedSolMint = (await this.getState())?.wrappedSolMint!
    if (stopAtMint?.equals(NATIVE_MINT)) {
      stopAtMint = wrappedSolMint;
    }

    if (!tokenBondingKey) {
      return;
    }
    const tokenBonding = await this.getTokenBonding(tokenBondingKey);
    if (!tokenBonding) {
      return;
    }

    const pricingCurve = await this.getBondingPricingCurve(tokenBondingKey);

    const parentKey = (
      await SplTokenBonding.tokenBondingKey(tokenBonding.baseMint)
    )[0];
    const ret = new BondingHierarchy({
      parent: stopAtMint?.equals(tokenBonding.baseMint)
        ? undefined
        : await this.getBondingHierarchy(parentKey, stopAtMint),
      tokenBonding,
      pricingCurve,
      wrappedSolMint
    });
    (ret.parent || ({} as any)).child = ret;
    return ret;
  }
}
