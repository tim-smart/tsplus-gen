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

export const ModuleConfig = z.object({
  staticPrefixes: z.array(z.string()).default([]),
  fluentNamespaces: z.array(z.string()).default([]),
})

export type ModuleConfig = z.infer<typeof ModuleConfig>

export const Config = z.object({
  packageName: z.string(),
  tsconfig: z.string(),
  rootDir: z.string(),
  exclude: z.array(z.string()).default([]),
  namespaceAliases: z.record(z.string()).default({}),
  moduleConfig: z.record(ModuleConfig).default({}),
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
        Ts.readConfigFile(a, Ts.sys.readFile).config,
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
  exclude,
  moduleConfig,
  namespaceAliases,
}: Config) =>
  Effect.gen(function* ($) {
    const baseDir = Path.join(process.cwd(), rootDir)
    const program = yield* $(Effect.fromEither(createProgram(tsconfig)))

    const excludeREs = exclude
      .map((a) => Minimatch.makeRe(a))
      .filter((a): a is RegExp => a !== false)

    const findModuleConfig = (module: string) => {
      const candidates = Object.entries(moduleConfig).filter(([prefix]) =>
        module.startsWith(prefix),
      )
      candidates.sort(([a], [b]) => b.length - a.length)
      return Maybe.fromNullable(candidates[0]?.[1])
    }

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

    const getFinalReturnTypeName = (signature: Ts.Signature) =>
      pipe(
        getFinalReturnType(signature),
        getTypeInformation,
        Maybe.map((a) => a.typeName),
        Maybe.toUndefined,
      )

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

    const hasStaticPrefix = (module: string, name: string) =>
      pipe(
        findModuleConfig(module),
        Maybe.filter(({ staticPrefixes }) =>
          staticPrefixes.some((prefix) => name.startsWith(prefix)),
        ),
        Maybe.isSome,
      )

    const fluentTypeInformation = (module: string, signature: Ts.Signature) =>
      pipe(
        Maybe.fromPredicate(signature, (a) => a.getParameters().length >= 1),
        Maybe.flatMap(() =>
          Maybe.struct({
            firstParamType: pipe(
              getFirstParamType(signature),
              Maybe.filter((a) =>
                isExportedInFluentNamespace(module, a.type, a.typeName),
              ),
            ),
            returnType: pipe(
              getFinalReturnType(signature),
              getTypeInformation,
              Maybe.some,
            ),
          }),
        ),
        Maybe.filter(({ firstParamType, returnType }) =>
          pipe(
            returnType,
            Maybe.fold(
              () => true,
              (a) => a.typeName === firstParamType.typeName,
            ),
          ),
        ),
      )

    const isExportedInFluentNamespace = (
      module: string,
      type: Ts.Type,
      typeName: string,
    ) => {
      const symbol = type.aliasSymbol ?? type.symbol
      if (!symbol) {
        return false
      } else if (
        pipe(
          findModuleConfig(module),
          Maybe.filter(({ fluentNamespaces }) =>
            fluentNamespaces.some((ns) => typeName.startsWith(ns)),
          ),
          Maybe.isNone,
        )
      ) {
        return false
      }

      if (typeName === symbol.name) return true

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

    const getterTypeInformation = (module: string, signature: Ts.Signature) =>
      pipe(
        Maybe.fromPredicate(signature, (a) => a.getParameters().length === 1),
        Maybe.filter((a) => nonFunctionReturnType(a.getReturnType())),
        Maybe.flatMap((a) =>
          Maybe.struct({
            firstParamType: getFirstParamType(a),
          }),
        ),
        Maybe.filter((a) =>
          isExportedInFluentNamespace(
            module,
            a.firstParamType.type,
            a.firstParamType.typeName,
          ),
        ),
      )

    const isPipeableSignature = (module: string) => (signature: Ts.Signature) =>
      pipe(getterTypeInformation(module, signature), Maybe.isSome)

    const pipeableSignature = (module: string, type: Ts.Type) =>
      Maybe.fromNullable(
        type.getCallSignatures().find(isPipeableSignature(module)),
      )

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
      maybeRenameNamespace(
        path
          .replace(/\/definition\/.*/, "")
          .replace(/^@/, "")
          .replace(/\/index$/, "")
          .replace(/\/_?(src|dist)\//, "/"),
      )

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

    const maybeRenameNamespace = (namespace: string) =>
      namespaceAliases[namespace] ?? namespace

    const getTargetString = (sourceFile: Ts.SourceFile, name: string) => {
      const namespace = getNamespaceFromSourceFile(sourceFile)
      const baseName = Path.basename(namespace)
      const namespaceWithoutSlashes = namespace.replaceAll("/", "")

      if (namespace.startsWith("typescript/")) {
        return name
      } else if (name === baseName) {
        return namespace
      } else if (name.startsWith(baseName)) {
        return `${maybeRenameNamespace(namespace)}.${name.slice(
          baseName.length,
        )}`
      } else if (namespaceWithoutSlashes.endsWith(name)) {
        return namespace
      }

      return `${maybeRenameNamespace(namespace)}.${name}`
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

    const exported = sourceFiles.flatMap(exportsFromSourceFile)

    const exportedWithDeclarations = pipe(
      exported
        .flatMap((a) =>
          uniqueNodesForSymbol(a.symbol).map((node) => ({
            ...a,
            node,
            sourceFile: node.getSourceFile(),
          })),
        )
        .map(({ symbol, sourceFile, node }) => {
          const type = checker.getTypeOfSymbolAtLocation(symbol, node)
          const module = getModuleFromSourceFile(sourceFile)
          const typeName = getTargetString(sourceFile, symbol.name)

          const exported = {
            symbol,
            node,
            type,
            sourceFile,
            module,
            typeName,
          }

          return [`${module}.${symbol.name}.${node.kind}`, exported] as const
        }),
      (a) => Object.fromEntries(a),
      (a) => Object.values(a),
    )

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
      .filter((a) => !nonFunctionReturnType(a.type))
      .map((a) => ({
        ...a,
        callSignature: a.type.getCallSignatures()![0],
      }))
      .map((a) => ({
        ...a,
        returnType: getReturnType(a.callSignature),
      }))

    const constants = variables
      .filter((a) => nonFunctionReturnType(a.type))
      .flatMap((a) =>
        pipe(
          getTypeInformation(a.type),
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
      .filter((a) => isExportedInFluentNamespace(a.module, a.type, a.typeName))

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
      hasStaticPrefix(a.module, a.symbol.name) ? Maybe.some(a) : Maybe.none,
    )

    const getters = extractCallables((a) =>
      pipe(
        getterTypeInformation(a.module, a.callSignature),
        Maybe.filter(
          () =>
            (a.callSignature.getReturnType().flags & Ts.TypeFlags.Boolean) ===
            0,
        ),
        Maybe.map((self) => ({
          ...a,
          typeName: self.firstParamType.typeName,
          outputTypeName: getFinalReturnTypeName(a.callSignature),
        })),
      ),
    )

    const pipeables = extractCallables((a) =>
      pipe(
        pipeableSignature(a.module, a.returnType),
        Maybe.map((returnCallSignature) => ({
          ...a,
          returnCallSignature,
        })),
        Maybe.flatMap((a) =>
          pipe(
            a.returnCallSignature.getParameters()[0],
            getSymbolType,
            getTypeInformation,
          ),
        ),
        Maybe.filter((self) =>
          isExportedInFluentNamespace(a.module, self.type, self.typeName),
        ),
        Maybe.map((self) => ({
          ...a,
          typeName: self.typeName,
          outputTypeName: getFinalReturnTypeName(a.callSignature),
        })),
      ),
    )

    const fluents = extractCallables((a) =>
      pipe(
        fluentTypeInformation(a.module, a.callSignature),
        Maybe.map((info) => ({
          ...a,
          typeName: info.firstParamType.typeName,
          outputTypeName: getFinalReturnTypeName(a.callSignature),
        })),
      ),
    )

    // Constructors
    const staticCallables = [...staticByName, ...callables].map((a) =>
      pipe(
        getFinalReturnType(a.callSignature),
        getTypeInformation,
        Maybe.filter(
          (type) =>
            isExportedInFluentNamespace(a.module, type.type, type.typeName) &&
            namespaceFromModule(a.module).startsWith(
              type.typeName.split(".")[0],
            ),
        ),
        Maybe.fold(
          () => ({
            ...a,
            typeName: namespaceFromModule(a.module),
          }),
          (self) => ({
            ...a,
            typeName: self.typeName,
          }),
        ),
      ),
    )

    const statics = [...staticCallables, ...constants]

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
