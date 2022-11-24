import * as Effect from "@effect/core/io/Effect"

const nonExportedConstant = 123

export interface TestInterface {}

export class TestClass {}

export const testConstant = 123

export const testGetter = <R, E, A>(self: Effect.Effect<R, E, A>) =>
  Effect.isSuccess(self)

export const testGetterUnderscore = <R, E, A>(_self: Effect.Effect<R, E, A>) =>
  true

export const testFluent =
  <A, B>(f: (a: A) => B) =>
  <R, E>(self: Effect.Effect<R, E, A>) =>
    Effect.map(f)(self)

export function testConstructor<A>(a: A) {
  return Effect.sync(() => a)
}

export type Special = number
