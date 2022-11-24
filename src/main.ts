import { Effect, Layer, Parser, pipe, Stream } from "./common.js"
import { FsLive } from "./Fs/index.js"

const ParserLive = Parser.make({
  moduleName: "tsplus-gen-example",
  baseDir: "./examples",
  tsconfig: "./tsconfig.json",
})

const EnvLive = pipe(FsLive, Layer.provideTo(ParserLive))

const label = <R, E, A, T extends string>(
  label: T,
  self: Stream.Stream<R, E, A>,
) =>
  pipe(
    self,
    Stream.map((a) => [label, a] as const),
  )

const main = pipe(
  label("static", Parser.statics),
  Stream.merge(label("getter", Parser.getters)),
  Stream.merge(label("pipeable", Parser.pipeables)),
  Stream.merge(label("constructor", Parser.constructors)),
  Stream.tap((a) =>
    Effect.sync(() => {
      switch (a[0]) {
        case "static":
          return console.log({
            kind: a[0],
            namespace: a[1].namespace,
            name: a[1].name,
          })
        default:
          return console.log({
            kind: a[0],
            namespace: a[1].selfType.namespace,
            type: a[1].selfType.name,
            name: a[1].symbol.name,
          })
      }
    }),
  ),
  Stream.runDrain,
)

pipe(main, Effect.provideLayer(EnvLive), Effect.unsafeRunPromise).catch(
  console.error,
)
