import * as Effect from "@effect/core/io/Effect"

const nonExportedConstant = 123

export interface TestInterface {}

export class TestClass<A> {}

export const flatMap =
  <A, B>(f: (a: A) => B) =>
  (_self: TestClass<A>) =>
    new TestClass<B>()

export const testConstant = 123

export const testGetter = <R, E, A>(self: Effect.Effect<R, E, A>) =>
  Effect.isSuccess(self)

export const testGetterUnderscore = <R, E, A>(_self: Effect.Effect<R, E, A>) =>
  true

export const testPipeable =
  <A, B>(f: (a: A) => B) =>
  <R, E>(self: Effect.Effect<R, E, A>) =>
    Effect.map(f)(self)

export const testPipeableInt =
  <A, B>(f: (a: A) => B) =>
  (self: number) =>
    self

export function testFluent<R, E, A, B>(
  self: Effect.Effect<R, E, A>,
  f: (a: A) => B,
) {
  return Effect.map(f)(self)
}

export const testAcquireRelease = Effect.acquireRelease

export function testConstructor<A>(a: A) {
  return Effect.sync(() => a)
}

export function sum(a: number, b: number) {
  return a + b
}

export type Special = number
