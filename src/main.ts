#!/usr/bin/env node

import { Effect, Parser, pipe, Serializer } from "./common.js"
import { fromFile } from "./Config/index.js"
import { FsLive } from "./Fs/index.js"

const main = pipe(
  fromFile(process.argv[2]),
  Effect.flatMap((config) => {
    const ParserLive = Parser.make(config.project)
    const SerializerLive = Serializer.makeLayer(config.namespaces)

    return pipe(
      Serializer.definitions,
      Effect.provideSomeLayer(ParserLive),
      Effect.provideSomeLayer(SerializerLive),
    )
  }),
  Effect.tap((a) =>
    Effect.sync(() => {
      console.log(JSON.stringify(a, null, 2))
    }),
  ),
)

pipe(main, Effect.provideLayer(FsLive), Effect.unsafeRunPromise).catch(
  console.error,
)
