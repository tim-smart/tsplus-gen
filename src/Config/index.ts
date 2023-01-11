import {
  Chunk,
  Effect,
  Fs,
  Parser,
  pipe,
  Serializer,
} from "tsplus-gen/common.js"
import { JsonAnnotations } from "tsplus-gen/Serializer/index.js"
import { z } from "zod"

export const Config = z.object({
  project: Parser.Config,
  mergeWith: z.array(z.string()).default([]),
  namespaces: Serializer.NamespaceList,
  additionalExtensions: Serializer.AdditionalExtensions.default([]),
})

export const fromFile = (path: string) =>
  Effect.gen(function* ($) {
    const config = yield* $(
      pipe(
        Fs.readFile(path),
        Effect.flatMap(parseBuffer),
        Effect.flatMap(decode),
      ),
    )

    const mergeWith = yield* $(parseMergeWith(config.mergeWith))

    return { ...config, mergeWith }
  })

const parseMergeWith = (paths: string[]) =>
  pipe(
    paths.map(parseExternalDefinitions),
    Effect.collectAllPar,
    Effect.map((c) => [...c]),
  )

const parseExternalDefinitions = (path: string) =>
  pipe(
    Fs.readFile(path),
    Effect.flatMap(parseBuffer),
    Effect.flatMap(decodeJsonAnnotations),
  )

export class JsonParseError {
  readonly _tag = "JsonParseError"
  constructor(readonly reason: unknown) {}
}

const parseBuffer = (a: Buffer) =>
  Effect.tryCatch(
    () => JSON.parse(a.toString("utf8")),
    (reason) => new JsonParseError(reason),
  )

const decode = (u: unknown) => {
  const result = Config.safeParse(u)
  return result.success
    ? Effect.succeed(result.data)
    : Effect.fail(result.error)
}

const decodeJsonAnnotations = (u: unknown) => {
  const result = JsonAnnotations.safeParse(u)
  return result.success
    ? Effect.succeed(result.data)
    : Effect.fail(result.error)
}
