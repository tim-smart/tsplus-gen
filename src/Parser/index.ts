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
import Minimatch from "minimatch"

export const TypeAlias = z.object({
  module: z.string(),
})

export const Config = z.object({
  packageName: z.string(),
  baseDir: z.string(),
  tsconfig: z.string(),
  paths: z.array(z.string()),
  staticPrefixes: z.array(z.string()).optional(),
})
export type Config = z.infer<typeof Config>

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

const rootNames = (baseDir: string) => {
  return pipe(
    Fs.walk(baseDir),
    Stream.filter((a) => a.endsWith(".ts")),
    Stream.runCollect,
    Effect.map(Collection.toArray),
  )
}

const makeParser = ({
  baseDir,
  packageName: moduleName,
  tsconfig,
  paths,
}: Config) =>
  Effect.gen(function* ($) {
    const options = yield* $(compilerOptions(tsconfig))
    const program = Ts.createProgram({
      rootNames: yield* $(rootNames(baseDir)),
      options,
    })

    const pathRes = paths
      .map((a) => Minimatch.makeRe(a))
      .filter((a): a is RegExp => a !== false)

    const checker = program.getTypeChecker()

    const sourceFiles = program
      .getSourceFiles()
      .filter((a) => !a.isDeclarationFile)
      .filter((a) => pathRes.every((re) => re.test(a.fileName)))

    const exportsFromSourceFile = (sourceFile: Ts.SourceFile) =>
      checker
        .getExportsOfModule(checker.getSymbolAtLocation(sourceFile)!)
        .map((symbol) => ({ sourceFile, symbol }))

    const getSymbolType = (symbol: Ts.Symbol) =>
      checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!)

    const getReturnType = (signature: Ts.Signature) =>
      checker.getReturnTypeOfSignature(signature)

    const exported = sourceFiles.flatMap(exportsFromSourceFile)

    const getFirstParamType = (signature: Ts.Signature) =>
      pipe(
        Maybe.fromNullable(signature.getParameters()?.[0]),
        Maybe.map(getSymbolType),
        Maybe.filter((a) => a.getCallSignatures().length === 0),
        Maybe.flatMap(getTypeInformation),
      )

    const fluentTypeInformation = (signature: Ts.Signature) =>
      pipe(
        Maybe.fromPredicate(signature, (a) => a.getParameters().length > 1),
        Maybe.flatMap((a) =>
          Maybe.struct({
            firstParamType: getFirstParamType(a),
            returnType: pipe(getReturnType(a), getTypeInformation),
          }),
        ),
        Maybe.filter(
          ({ firstParamType, returnType }) =>
            firstParamType.typeName === returnType.typeName,
        ),
      )

    const getterTypeInformation = (signature: Ts.Signature) =>
      pipe(
        Maybe.fromPredicate(signature, (a) => a.getParameters().length === 1),
        Maybe.filter((a) => a.getReturnType().getCallSignatures().length === 0),
        Maybe.flatMap((a) =>
          Maybe.struct({
            firstParamType: getFirstParamType(a),
          }),
        ),
      )

    const isPipeableSignature = (signature: Ts.Signature) =>
      pipe(
        Maybe.fromPredicate(signature, (a) => a.getParameters().length === 1),
        Maybe.filter((a) => a.getReturnType().getCallSignatures().length === 0),
        Maybe.isSome,
      )

    const isPipeableReturnType = (type: Ts.Type) =>
      type.getCallSignatures().some(isPipeableSignature)

    const getSourceFileFromSymbol = (symbol: Ts.Symbol) =>
      pipe(
        Maybe.fromNullable(symbol.getDeclarations()),
        Maybe.map((a) => a[0]),
        Maybe.map((a) => a.getSourceFile()),
      )

    const getModuleFromSourceFile = (file: Ts.SourceFile) =>
      pipe(
        file.fileName.includes("/node_modules/")
          ? getExternalModulePath(file.fileName)
          : getInternalModulePath(file.fileName),
        (path) => path.replace(/\.tsx?$/, ""),
      )
    const getNamespaceFromSourceFile = (file: Ts.SourceFile) =>
      getModuleFromSourceFile(file)
        .replace(/\/definition\/.*/, "")
        .replace(/^@/, "")
        .replace(/\/index$/, "")

    const getExternalModulePath = (file: string) =>
      file.match(/.*\/node_modules\/(.*)/)![1]

    const getInternalModulePath = (file: string) =>
      `${moduleName}/${Path.relative(baseDir, file)}`

    const getTypeInformation = (type: Ts.Type) =>
      pipe(
        Maybe.fromNullable(type.aliasSymbol ?? type.symbol),
        Maybe.filter(() => !type.isTypeParameter()),
        Maybe.flatMap((symbol) =>
          Maybe.struct({
            name: Maybe.fromNullable(symbol.name),
            sourceFile: getSourceFileFromSymbol(symbol),
          }),
        ),
        Maybe.map(({ name, sourceFile }) => ({
          type,
          name,
          sourceFile,
          typeName: getTargetString(sourceFile, name),
        })),
      )

    const getTargetString = (sourceFile: Ts.SourceFile, name: string) => {
      const namespace = getNamespaceFromSourceFile(sourceFile)
      const baseName = Path.basename(namespace)
      const namespaceWithoutSlashes = namespace.replaceAll("/", "")

      if (name === baseName) {
        return namespace
      } else if (name.startsWith(baseName)) {
        return `${namespace}.${name.slice(baseName.length)}`
      } else if (namespaceWithoutSlashes.endsWith(name)) {
        return namespace
      }

      return `${namespace}.${name}`
    }

    const exportedWithDeclarations = exported.map(({ symbol, sourceFile }) => {
      const node = symbol.getDeclarations()![0]
      const type = checker.getTypeOfSymbolAtLocation(symbol, node)
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
        a.type
          .getCallSignatures()
          .slice(0, 1)
          .map((callSignature) => ({
            ...a,
            callSignature,
          })),
      )
      .map((a) => ({
        ...a,
        returnType: getReturnType(a.callSignature),
      }))

    const getters = callables.flatMap((a) =>
      pipe(
        getterTypeInformation(a.callSignature),
        Maybe.fold(
          () => [],
          (self) => [
            {
              ...a,
              typeName: self.firstParamType.typeName,
            },
          ],
        ),
      ),
    )

    const fluents = callables.flatMap((a) =>
      pipe(
        Maybe.fromPredicate(
          a.callSignature,
          (a) => a.getReturnType().getCallSignatures().length === 0,
        ),
        Maybe.flatMap(fluentTypeInformation),
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
        returnCallSignature: a.returnType
          .getCallSignatures()
          .find(isPipeableSignature)!,
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
          Maybe.isNone(getterTypeInformation(a.callSignature)) &&
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
export const make = (a: Config) => Layer.scoped(Parser, makeParser(a))

export const fluents = Stream.serviceWithStream(Parser, (a) => a.fluents)
export const getters = Stream.serviceWithStream(Parser, (a) => a.getters)
export const pipeables = Stream.serviceWithStream(Parser, (a) => a.pipeables)
export const statics = Stream.serviceWithStream(Parser, (a) => a.statics)
export const types = Stream.serviceWithStream(Parser, (a) => a.types)
