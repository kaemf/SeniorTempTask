/**
 * Strips the stack trace from a tRPC error shape so internals never leak to
 * clients, regardless of NODE_ENV. Pure shape-to-shape transform; every other
 * field (message, code, remaining data fields) passes through untouched.
 */
export function stripErrorStack<TShape extends { data: { stack?: string | undefined } }>(
  shape: TShape,
): TShape {
  const data = { ...shape.data };
  delete data.stack;
  return { ...shape, data };
}
