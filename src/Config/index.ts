import { Effect, Fs, Parser, pipe, Serializer } from "tsplus-gen/common.js"
import { z } from "zod"

export const Config = z.object({
  project: Parser.Config,
  namespaces: Serializer.NamespaceList,
  additionalExtensions: Serializer.AdditionalExtensions.optional(),
})

export const fromFile = (path: string) =>
  pipe(Fs.readFile(path), Effect.flatMap(parseBuffer), Effect.flatMap(decode))

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
