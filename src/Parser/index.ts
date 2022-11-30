import {
  Effect,
  Either,
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

export const Config = z.object({
  packageName: z.string(),
  tsconfig: z.string(),
  rootDir: z.string(),
  exclude: z.array(z.string()).optional(),
  staticPrefixes: z.array(z.string()).optional(),
  getterNamespaces: z.array(z.string()).optional(),
})
export type Config = z.infer<typeof Config>

export class TsconfigParseError {
  readonly _tag = "TsconfigParseError"
  constructor(readonly reason: unknown) {}
}

export class CreateProgramError {
  readonly _tag = "CreateProgramError"
  constructor(readonly message: string) {}
}

const createProgram = (tsconfig: string) =>
  pipe(
    Either.fromNullable(
      Ts.findConfigFile(process.cwd(), Ts.sys.fileExists, tsconfig),
      () => new CreateProgramError("could not find config file"),
    ),
    Either.flatMap((a) =>
      Either.fromNullable(
        Ts.readConfigFile(a, Ts.sys.readFile),
        () => new CreateProgramError("could not read config file"),
      ),
    ),
    Either.map((a) => Ts.parseJsonConfigFileContent(a, Ts.sys, process.cwd())),
    Either.map(({ options, fileNames, errors }) =>
      Ts.createProgram({
        options,
        rootNames: fileNames,
        configFileParsingDiagnostics: errors,
      }),
    ),
  )

const makeParser = ({
  packageName,
  rootDir,
  tsconfig,
  exclude = [],
  staticPrefixes = [],
  getterNamespaces = [],
}: Config) =>
  Effect.gen(function* ($) {
    const baseDir = Path.join(process.cwd(), rootDir)
    const program = yield* $(Effect.fromEither(createProgram(tsconfig)))

    const excludeREs = exclude
      .map((a) => Minimatch.makeRe(a))
      .filter((a): a is RegExp => a !== false)

    const checker = program.getTypeChecker()

    const sourceFiles = program
      .getSourceFiles()
      .filter((a) => a.fileName.startsWith(baseDir))
      .filter((a) => !a.isDeclarationFile)
      .filter((a) => !excludeREs.some((re) => re.test(a.fileName)))

    const exportsFromSourceFile = (sourceFile: Ts.SourceFile) => {
      const symbol = checker.getSymbolAtLocation(sourceFile)
      if (!symbol) return []
      return checker
        .getExportsOfModule(symbol)
        .map((symbol) => ({ sourceFile, symbol }))
    }

    const getSymbolType = (symbol: Ts.Symbol) =>
      checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!)

    const getReturnType = (signature: Ts.Signature) =>
      checker.getReturnTypeOfSignature(signature)

    const getFinalReturnType = (signature: Ts.Signature): Ts.Type => {
      const returnType = signature.getReturnType()

      if (nonFunctionReturnType(returnType)) {
        return returnType
      }

      return getFinalReturnType(returnType.getCallSignatures()[0])
    }

    const exported = sourceFiles.flatMap(exportsFromSourceFile)

    const getFirstParamType = (signature: Ts.Signature) =>
      pipe(
        Maybe.fromNullable(signature.getParameters()?.[0]),
        Maybe.map(getSymbolType),
        Maybe.filter((a) => nonFunctionReturnType(a)),
        Maybe.flatMap(getTypeInformation),
      )

    const nonFunctionReturnType = (type: Ts.Type) => {
      const symbol = type.aliasSymbol ?? type.symbol
      const isType = symbol
        ?.getDeclarations()
        ?.some(
          (a) =>
            Ts.isClassDeclaration(a) ||
            Ts.isTypeAliasDeclaration(a) ||
            Ts.isInterfaceDeclaration(a),
        )

      if (!symbol || isType === true) {
        return true
      } else if (type.getCallSignatures().length === 0) {
        return true
      }

      return false
    }

    const hasStaticPrefix = (name: string) =>
      staticPrefixes.some((prefix) => name.startsWith(prefix))

    const fluentTypeInformation = (signature: Ts.Signature) =>
      pipe(
        Maybe.fromPredicate(signature, (a) => a.getParameters().length > 1),
        Maybe.filter((signature) =>
          nonFunctionReturnType(signature.getReturnType()),
        ),
        Maybe.flatMap(() =>
          Maybe.struct({
            firstParamType: getFirstParamType(signature),
            returnType: pipe(getReturnType(signature), getTypeInformation),
          }),
        ),
        Maybe.filter((a) =>
          isExportedInGetterNamespace(
            a.firstParamType.type,
            a.firstParamType.typeName,
          ),
        ),
      )

    const isExportedInGetterNamespace = (type: Ts.Type, typeName: string) => {
      const symbol = type.aliasSymbol ?? type.symbol
      if (!symbol) {
        return false
      } else if (!getterNamespaces.some((ns) => typeName.startsWith(ns))) {
        return false
      }

      return (
        symbol
          .getDeclarations()
          ?.some((a) =>
            exportsFromSourceFile(a.getSourceFile()).some(
              (a) => a.symbol.name === symbol.name,
            ),
          ) === true
      )
    }

    const getterTypeInformation = (signature: Ts.Signature) =>
      pipe(
        Maybe.fromPredicate(signature, (a) => a.getParameters().length === 1),
        Maybe.filter((a) => nonFunctionReturnType(a.getReturnType())),
        Maybe.flatMap((a) =>
          Maybe.struct({
            firstParamType: getFirstParamType(a),
          }),
        ),
        Maybe.filter((a) =>
          isExportedInGetterNamespace(
            a.firstParamType.type,
            a.firstParamType.typeName,
          ),
        ),
      )

    const isPipeableSignature = (signature: Ts.Signature) =>
      pipe(getterTypeInformation(signature), Maybe.isSome)

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
        (path) => path.replace(/\.d\.ts$/, "").replace(/\.ts$/, ""),
      )
    const getNamespaceFromSourceFile = (file: Ts.SourceFile) =>
      pipe(getModuleFromSourceFile(file), namespaceFromModule)

    const namespaceFromModule = (path: string) =>
      path
        .replace(/\/definition\/.*/, "")
        .replace(/^@/, "")
        .replace(/\/index$/, "")

    const getExternalModulePath = (file: string) =>
      file.match(/.*\/node_modules\/(.*)/)![1]

    const getInternalModulePath = (file: string) =>
      `${packageName}/${Path.relative(baseDir, file)}`

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
          typeName: getTargetString(sourceFile, name),
        })),
      )

    const getTargetString = (sourceFile: Ts.SourceFile, name: string) => {
      const namespace = getNamespaceFromSourceFile(sourceFile)
      const baseName = Path.basename(namespace)
      const namespaceWithoutSlashes = namespace.replaceAll("/", "")

      if (namespace.startsWith("typescript/")) {
        return name
      } else if (name === baseName) {
        return namespace
      } else if (name.startsWith(baseName)) {
        return `${namespace}.${name.slice(baseName.length)}`
      } else if (namespaceWithoutSlashes.endsWith(name)) {
        return namespace
      }

      return `${namespace}.${name}`
    }

    const uniqueNodesForSymbol = (s: Ts.Symbol) =>
      pipe(
        s.getDeclarations()!.reduce<Record<number, Ts.Node>>((acc, n) => {
          if (acc[n.kind]) return acc
          return {
            ...acc,
            [n.kind]: n,
          }
        }, {}),
        (a) => Object.values(a),
      )

    const exportedWithDeclarations = exported
      .flatMap((a) =>
        uniqueNodesForSymbol(a.symbol).map((node) => ({
          ...a,
          node,
        })),
      )
      .map(({ symbol, sourceFile, node }) => {
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

    let callables = [...variables, ...functions]
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

    type Callable = typeof callables[number]

    const extractCallables = <A>(f: (a: Callable) => Maybe.Maybe<A>): A[] => {
      const [results, newCallables] = callables.reduce<[A[], Callable[]]>(
        ([selected, remaining], a) => {
          return pipe(
            f(a),
            Maybe.fold(
              () => [selected, [...remaining, a]],
              (a) => [[...selected, a], remaining],
            ),
          )
        },
        [[], []],
      )

      callables = newCallables

      return results
    }

    const staticByName = extractCallables((a) =>
      hasStaticPrefix(a.symbol.name) ? Maybe.some(a) : Maybe.none,
    )

    const getters = extractCallables((a) =>
      pipe(
        getterTypeInformation(a.callSignature),
        Maybe.map((self) => ({
          ...a,
          typeName: self.firstParamType.typeName,
        })),
      ),
    )

    const fluents = extractCallables((a) =>
      pipe(
        fluentTypeInformation(a.callSignature),
        Maybe.map((info) => ({
          ...a,
          typeName: info.firstParamType.typeName,
        })),
      ),
    )

    const pipeables = extractCallables((a) =>
      pipe(
        Maybe.fromPredicate(a, (a) => isPipeableReturnType(a.returnType)),
        Maybe.map((a) => ({
          ...a,
          returnCallSignature: a.returnType
            .getCallSignatures()
            .find(isPipeableSignature)!,
        })),
        Maybe.flatMap((a) =>
          pipe(
            a.returnCallSignature.getParameters()[0],
            getSymbolType,
            getTypeInformation,
          ),
        ),
        Maybe.filter((self) =>
          self.typeName.startsWith(namespaceFromModule(a.module)),
        ),
        Maybe.map((self) => ({
          ...a,
          typeName: self.typeName,
        })),
      ),
    )

    // Constructors
    const statics = [...staticByName, ...callables].map((a) => ({
      ...a,
      typeName: namespaceFromModule(a.module),
    }))

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
