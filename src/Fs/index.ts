import * as NodeFs from "fs";
import * as Path from "path";
import { Effect, Layer, pipe, Stream, Tag } from "tsplus-gen/common.js";

const makeFs = () => {
  const readdir = (path: string) =>
    Effect.async<never, NodeJS.ErrnoException, NodeFs.Dirent[]>((cb) =>
      NodeFs.readdir(path, { withFileTypes: true }, (err, files) => {
        if (err) {
          cb(Effect.fail(err));
        } else {
          cb(Effect.succeed(files));
        }
      })
    );

  const readFile = (path: string) =>
    Effect.async<never, NodeJS.ErrnoException, Buffer>((cb) =>
      NodeFs.readFile(path, (err, buffer) => {
        if (err) {
          cb(Effect.fail(err));
        } else {
          cb(Effect.succeed(buffer));
        }
      })
    );

  const writeFile = (path: string, content: string | Buffer) =>
    Effect.async<never, NodeJS.ErrnoException, void>((cb) =>
      NodeFs.writeFile(path, content, (err) => {
        if (err) {
          cb(Effect.fail(err));
        } else {
          cb(Effect.unit);
        }
      })
    );

  const walk = (
    path: string
  ): Stream.Stream<never, NodeJS.ErrnoException, string> =>
    pipe(
      Stream.fromEffect(readdir(path)),
      Stream.flatMap(Stream.fromCollection),
      Stream.flatMap((file) => {
        if (file.isFile()) {
          return Stream.succeed(Path.join(path, file.name));
        } else if (file.isDirectory()) {
          return walk(Path.join(path, file.name));
        }

        return Stream.empty;
      })
    );

  return {
    readdir,
    readFile,
    writeFile,
    walk,
  } as const;
};

export interface Fs extends ReturnType<typeof makeFs> {}
export const Fs = Tag.Tag<Fs>();
export const FsLive = Layer.fromValue(Fs, makeFs);

export const { readdir, readFile, writeFile } = Effect.deriveLifted(Fs)(
  ["readdir", "readFile", "writeFile"],
  [],
  []
);
export const walk = (path: string) =>
  Stream.serviceWithStream(Fs, (fs) => fs.walk(path));
