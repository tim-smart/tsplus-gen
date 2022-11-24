import { Effect, Layer, Parser, pipe, Serializer } from "./common.js"
import { FsLive } from "./Fs/index.js"

const ParserLive = Parser.make({
  moduleName: "tsplus-gen-example",
  baseDir: "./examples",
  tsconfig: "./tsconfig.json",
})

const EnvLive = pipe(FsLive, Layer.provideTo(ParserLive))

const main = pipe(
  Serializer.definitions,
  Effect.tap((a) =>
    Effect.sync(() => {
      console.log(JSON.stringify(a, null, 2))
    }),
  ),
)

pipe(main, Effect.provideLayer(EnvLive), Effect.unsafeRunPromise).catch(
  console.error,
)
