import { SplTokenBonding } from "@strata-foundation/spl-token-bonding";
import anchor from "@project-serum/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

async function run() {  console.log(process.env.ANCHOR_PROVIDER_URL)
  anchor.setProvider(anchor.Provider.env());
  const provider = anchor.getProvider();
  const me = provider.wallet.publicKey;
  

  const tokenBondingSdk = await SplTokenBonding.init(provider);
  
  const tokenBonding = new PublicKey("FURpKZG2iPY5NXUvzb4A4JWt61CopLVEzqPYwoerEewC");
  const tokenBondingAcct = (await tokenBondingSdk.getTokenBonding(tokenBonding))!;
  await tokenBondingSdk.program.rpc.upgradeBaseStorageAuthority({
    accounts: {
      tokenBonding,
      baseStorage: tokenBondingAcct.baseStorage,
      tokenProgram: TOKEN_PROGRAM_ID,
      baseStorageAuthority: (await PublicKey.findProgramAddress([Buffer.from("storage-authority", "utf-8"), tokenBonding.toBuffer()], tokenBondingSdk.programId))[0]
    }
  })
}