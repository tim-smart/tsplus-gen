#!/usr/bin/env node

import { Effect, Fs, Maybe, Parser, pipe, Serializer } from "./common.js"
import { fromFile } from "./Config/index.js"
import { FsLive } from "./Fs/index.js"
import * as Path from "path"

const outputFile = Maybe.fromNullable(process.argv[3])

const writeOutput = (path: string, u: unknown) =>
  pipe(
    Effect.sync(() => JSON.stringify(u, null, 2)),
    Effect.tap(() => Fs.mkdir(Path.dirname(path), { recursive: true })),
    Effect.tap((a) => Fs.writeFile(path, a)),
    Effect.asUnit,
  )

const main = pipe(
  fromFile(process.argv[2]),
  Effect.flatMap((config) => {
    const ParserLive = Parser.make(config.project)
    const SerializerLive = Serializer.makeLayer(
      config.namespaces,
      config.additionalExtensions,
      config.mergeWith,
    )

    return pipe(
      Serializer.definitions,
      Effect.provideSomeLayer(ParserLive),
      Effect.provideSomeLayer(SerializerLive),
    )
  }),
  Effect.tap((a) =>
    pipe(
      outputFile,
      Maybe.fold(
        () =>
          Effect.sync(() => {
            console.log(JSON.stringify(a, null, 2))
          }),
        (path) => writeOutput(path, a),
      ),
    ),
  ),
)

pipe(main, Effect.provideLayer(FsLive), Effect.unsafeRunPromise).catch(
  console.error,
)
