use super::arg::SwapV0Args;
use crate::error::ErrorCode;
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use crate::state::*;

pub struct SwapAmount {
  pub amount: u64,
}

pub fn swap_shared_logic(
  parent_entangler: &Account<FungibleParentEntanglerV0>,
  child_entangler: &Account<FungibleChildEntanglerV0>,
  base: &Account<TokenAccount>,
  source: &Account<TokenAccount>,
  clock: &Sysvar<Clock>,
  args: &SwapV0Args,
) -> Result<SwapAmount> {
  let amount: u64;
  let clock = clock;
  
  require!(
    (args.all.is_some() && args.all == Some(true)) || args.amount.is_some(),
    ErrorCode::InvalidArgs
  );

  require!(
    parent_entangler.go_live_unix_time < clock.unix_timestamp,
    ErrorCode::ParentNotLiveYet
  );

  require!(
    child_entangler.go_live_unix_time < clock.unix_timestamp,
    ErrorCode::ChildNotLiveYet
  );

  require!(
    parent_entangler.freeze_swap_unix_time.is_none() || (parent_entangler.freeze_swap_unix_time > Some(clock.unix_timestamp)),
    ErrorCode::ParentSwapFrozen
  );

  require!(
    child_entangler.freeze_swap_unix_time.is_none() || (child_entangler.freeze_swap_unix_time > Some(clock.unix_timestamp)),
    ErrorCode::ChildSwapFrozen
  );

  if args.all == Some(true) {
    amount = if source.amount > base.amount {
      base.amount
    } else {
      source.amount
    };
  } else {
    amount = args.amount.unwrap();

    require!(base.amount >= amount, ErrorCode::TokenAccountAmountTooLow);
  }

  Ok(SwapAmount { amount })
}
