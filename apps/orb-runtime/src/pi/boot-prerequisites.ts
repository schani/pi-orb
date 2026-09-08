import { err, ok, type Result } from "neverthrow";

/** Waits for both boot prerequisites and gives Rust failures stable precedence. */
export async function settleBootPrerequisites<Rust, Checkout, Failure>(
  rust: () => PromiseLike<Result<Rust, Failure>>,
  checkout: () => PromiseLike<Result<Checkout, Failure>>,
): Promise<Result<readonly [Rust, Checkout], Failure>> {
  const rustWork = rust();
  const checkoutWork = checkout();
  const [rustResult, checkoutResult] = await Promise.all([rustWork, checkoutWork]);
  if (rustResult.isErr()) return err(rustResult.error);
  if (checkoutResult.isErr()) return err(checkoutResult.error);
  return ok([rustResult.value, checkoutResult.value] as const);
}
