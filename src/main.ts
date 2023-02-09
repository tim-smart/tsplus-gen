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
  Effect.map(root =>
    Object.keys(root)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, key) => ({
        ...acc,
        [key]: root[key].sort((a, b) => {
          const aIsType = a.definitionKind === "type" || a.definitionKind === "interface";
          const bIsType = b.definitionKind === "type" || b.definitionKind === "interface";

          if (aIsType !== bIsType) {
            if (aIsType) return -1;
            return 1;
          }


          const aIsUpperCase = a.definitionName[0].toUpperCase() === a.definitionName[0];
          const bIsUpperCase = b.definitionName[0].toUpperCase() === b.definitionName[0];

          if (aIsUpperCase !== bIsUpperCase) {
            if (aIsUpperCase) return -1;
            return 1;
          }
          return a.definitionName.localeCompare(b.definitionName);
        })
      }), {})
  ),
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
