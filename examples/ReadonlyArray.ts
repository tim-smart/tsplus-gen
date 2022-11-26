import { Effect } from "@effect/core/io/Effect"

export const pipeable =
  <A, B>(f: (a: A) => B) =>
  (self: ReadonlyArray<A>): ReadonlyArray<B> =>
    self.map(f)

export const fromEffect = <A>(
  _effect: Effect<any, any, A>,
): ReadonlyArray<A> => []
