import {
  Collection,
  Effect,
  Fs,
  Layer,
  Maybe,
  pipe,
  Stream,
  Tag,
} from "tsplus-gen/common.js"
import Ts from "typescript"
import * as Path from "path"
import { z } from "zod"

export const TsProject = z.object({
  moduleName: z.string(),
  baseDir: z.string(),
  tsconfig: z.string(),
})
export type TsConfig = z.infer<typeof TsProject>

export class TsconfigParseError {
  readonly _tag = "TsconfigParseError"
  constructor(readonly reason: unknown) {}
}

const compilerOptions = (path: string) =>
  pipe(
    Fs.readFile(path),
    Effect.flatMap((buffer) =>
      Effect.tryCatch(
        () => JSON.parse(buffer.toString("utf8")),
        (reason) => new TsconfigParseError(reason),
      ),
    ),
    Effect.map(
      (json) =>
        Ts.convertCompilerOptionsFromJson(json.compilerOptions, ".").options,
    ),
  )

const rootNames = (baseDir: string) =>
  pipe(
    Fs.walk(baseDir),
    Stream.filter((a) => a.endsWith(".ts")),
    Stream.runCollect,
    Effect.map(Collection.toArray),
  )

const makeParser = ({ baseDir, moduleName, tsconfig }: TsConfig) =>
  Effect.gen(function* ($) {
    const options = yield* $(compilerOptions(tsconfig))
    const program = Ts.createProgram({
      rootNames: yield* $(rootNames(baseDir)),
      options,
    })

    const checker = program.getTypeChecker()

    const sourceFiles = program
      .getSourceFiles()
      .filter((a) => !a.isDeclarationFile)

    const exportsFromSourceFile = (sourceFile: Ts.SourceFile) =>
      checker.getExportsOfModule(checker.getSymbolAtLocation(sourceFile)!)

    const getSymbolType = (symbol: Ts.Symbol) =>
      checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!)

    const getReturnType = (signature: Ts.Signature) =>
      checker.getReturnTypeOfSignature(signature)

    const exported = sourceFiles.flatMap(exportsFromSourceFile)

    const isGetter = (signature: Ts.Signature) =>
      pipe(
        Maybe.fromPredicate(signature.getParameters(), (a) => a.length === 1),
        Maybe.map((a) => a[0]),
        Maybe.filter((a) => ["self", "_self"].includes(a.name)),
        Maybe.isSome,
      )

    const fluentTypeInformation = (signature: Ts.Signature) => {
      return pipe(
        Maybe.struct({
          firstParamType: pipe(
            Maybe.fromPredicate(signature.getParameters(), (a) => a.length > 1),
            Maybe.map((a) => a[0]),
            Maybe.map(getSymbolType),
            Maybe.flatMap(getTypeInformation),
          ),
          returnType: pipe(getReturnType(signature), getTypeInformation),
        }),
        Maybe.filter(
          ({ firstParamType, returnType }) =>
            firstParamType.typeName === returnType.typeName,
        ),
      )
    }

    const isPipeableReturnType = (type: Ts.Type) =>
      type.getCallSignatures().some(isGetter)

    const getSourceFileFromType = (type: Ts.Type) =>
      type.symbol.valueDeclaration!.getSourceFile()

    const getModuleFromSourceFile = (file: Ts.SourceFile) =>
      pipe(
        file.fileName.includes("/node_modules/")
          ? getExternalModulePath(file.fileName)
          : getInternalModulePath(file.fileName),
        (path) => path.replace(/\.tsx?$/, ".js"),
      )
    const getNamespaceFromSourceFile = (file: Ts.SourceFile) =>
      getModuleFromSourceFile(file)
        .replace(/\/definition\/.*/, "")
        .replace(/^@/, "")
        .replace(/\.js$/, "")
        .replace(/\/index$/, "")

    const getExternalModulePath = (file: string) =>
      file.match(/.*\/node_modules\/(.*)/)![1]

    const getInternalModulePath = (file: string) =>
      `${moduleName}/${Path.relative(baseDir, file)}`

    const getTypeInformation = (type: Ts.Type) =>
      pipe(
        Maybe.fromNullable(type?.symbol?.name),
        Maybe.map((name) => {
          const sourceFile = getSourceFileFromType(type)
          return {
            type,
            name,
            sourceFile,
            typeName: getTargetString(sourceFile, name),
          }
        }),
      )

    const getTargetString = (sourceFile: Ts.SourceFile, name: string) => {
      const namespace = getNamespaceFromSourceFile(sourceFile)
      const baseName = Path.basename(namespace)

      if (name === baseName) {
        return namespace
      } else if (name.startsWith(baseName)) {
        return `${namespace}.${name.slice(baseName.length)}`
      }

      return `${namespace}.${name}`
    }

    const exportedWithDeclarations = exported.map((symbol) => {
      const node = symbol.getDeclarations()![0]
      const type = checker.getTypeOfSymbolAtLocation(symbol, node)
      const sourceFile = node.getSourceFile()
      const module = getModuleFromSourceFile(sourceFile)
      const typeName = getTargetString(sourceFile, symbol.name)

      return {
        symbol,
        node,
        type,
        sourceFile,
        module,
        typeName,
      }
    })

    const filterExports = <K extends string, A extends Ts.Node>(
      kind: K,
      f: (a: Ts.Node) => a is A,
    ) =>
      exportedWithDeclarations
        .filter((a) => f(a.node))
        .map((a) => ({
          ...a,
          kind,
          node: a.node as any as A,
        }))

    const classes = filterExports("class", Ts.isClassDeclaration)
    const variables = filterExports("const", Ts.isVariableDeclaration)
    const functions = filterExports("function", Ts.isFunctionDeclaration)
    const interfaces = filterExports("interface", Ts.isInterfaceDeclaration)
    const typeAliases = filterExports("type", Ts.isTypeAliasDeclaration)

    const callables = [...variables, ...functions]
      .flatMap((a) =>
        a.type.getCallSignatures().map((callSignature) => ({
          ...a,
          callSignature,
        })),
      )
      .map((a) => ({
        ...a,
        returnType: getReturnType(a.callSignature),
      }))

    const getters = callables
      .filter((a) => isGetter(a.callSignature))
      .flatMap((a) =>
        pipe(
          a.callSignature.getParameters()[0],
          getSymbolType,
          getTypeInformation,
          Maybe.fold(
            () => [],
            (self) => [
              {
                ...a,
                typeName: self.typeName,
              },
            ],
          ),
        ),
      )

    const fluents = callables.flatMap((a) =>
      pipe(
        fluentTypeInformation(a.callSignature),
        Maybe.fold(
          () => [],
          (info) => ({
            ...a,
            typeName: info.firstParamType.typeName,
          }),
        ),
      ),
    )

    const pipeables = callables
      .filter((a) => isPipeableReturnType(a.returnType))
      .map((a) => ({
        ...a,
        returnCallSignature: a.returnType.getCallSignatures().find(isGetter)!,
      }))
      .flatMap((a) =>
        pipe(
          a.returnCallSignature.getParameters()[0],
          getSymbolType,
          getTypeInformation,
          Maybe.fold(
            () => [],
            (self) => [
              {
                ...a,
                typeName: self.typeName,
              },
            ],
          ),
        ),
      )

    // Constructors
    const statics = callables
      .filter(
        (a) =>
          Maybe.isNone(fluentTypeInformation(a.callSignature)) &&
          a.returnType.getCallSignatures().length === 0,
      )
      .flatMap((a) =>
        pipe(
          a.returnType,
          getTypeInformation,
          Maybe.fold(
            () => [],
            (self) => [
              {
                ...a,
                typeName: self.typeName,
              },
            ],
          ),
        ),
      )

    const types = [...classes, ...interfaces, ...typeAliases]

    return {
      fluents: Stream.fromCollection(fluents),
      getters: Stream.fromCollection(getters),
      pipeables: Stream.fromCollection(pipeables),
      statics: Stream.fromCollection(statics),
      types: Stream.fromCollection(types),
    }
  })

export interface Parser
  extends Effect.Effect.Success<ReturnType<typeof makeParser>> {}
export const Parser = Tag.Tag<Parser>()
export const make = (a: TsConfig) => Layer.scoped(Parser, makeParser(a))

export const fluents = Stream.serviceWithStream(Parser, (a) => a.fluents)
export const getters = Stream.serviceWithStream(Parser, (a) => a.getters)
export const pipeables = Stream.serviceWithStream(Parser, (a) => a.pipeables)
export const statics = Stream.serviceWithStream(Parser, (a) => a.statics)
export const types = Stream.serviceWithStream(Parser, (a) => a.types)
