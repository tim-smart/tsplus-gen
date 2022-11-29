import * as NodeFs from "fs"
import { Effect, Layer, Tag } from "tsplus-gen/common.js"

const makeFs = () => {
  const readdir = (path: string) =>
    Effect.async<never, NodeJS.ErrnoException, NodeFs.Dirent[]>((cb) =>
      NodeFs.readdir(path, { withFileTypes: true }, (err, files) => {
        if (err) {
          cb(Effect.fail(err))
        } else {
          cb(Effect.succeed(files))
        }
      }),
    )

  const readFile = (path: string) =>
    Effect.async<never, NodeJS.ErrnoException, Buffer>((cb) =>
      NodeFs.readFile(path, (err, buffer) => {
        if (err) {
          cb(Effect.fail(err))
        } else {
          cb(Effect.succeed(buffer))
        }
      }),
    )

  const writeFile = (path: string, content: string | Buffer) =>
    Effect.async<never, NodeJS.ErrnoException, void>((cb) =>
      NodeFs.writeFile(path, content, (err) => {
        if (err) {
          cb(Effect.fail(err))
        } else {
          cb(Effect.unit)
        }
      }),
    )

  const mkdir = (path: string, opts: NodeFs.MakeDirectoryOptions = {}) =>
    Effect.async<never, NodeJS.ErrnoException, void>((cb) =>
      NodeFs.mkdir(path, opts, (err) => {
        if (err) {
          cb(Effect.fail(err))
        } else {
          cb(Effect.unit)
        }
      }),
    )

  return {
    readdir,
    readFile,
    writeFile,
    mkdir,
  } as const
}

export interface Fs extends ReturnType<typeof makeFs> {}
export const Fs = Tag.Tag<Fs>()
export const FsLive = Layer.fromValue(Fs, makeFs)

export const { readdir, readFile, writeFile, mkdir } = Effect.deriveLifted(Fs)(
  ["readdir", "readFile", "writeFile", "mkdir"],
  [],
  [],
)
