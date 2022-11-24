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

export interface ParserConfig {
  moduleName: string
  baseDir: string
  tsconfig: string
}

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

const makeParser = ({ baseDir, moduleName, tsconfig }: ParserConfig) =>
  Effect.gen(function* ($) {
    const options = yield* $(compilerOptions(tsconfig))
    const program = Ts.createProgram({
      rootNames: yield* $(rootNames(baseDir)),
      options,
    })

    const checker = program.getTypeChecker()

    return { program, checker, baseDir, moduleName }
  })

export interface Parser
  extends Effect.Effect.Success<ReturnType<typeof makeParser>> {}
export const Parser = Tag.Tag<Parser>()
export const make = (a: ParserConfig) =>
  pipe(makeParser(a), Layer.fromEffect(Parser))

const withChecker = <A>(f: (checker: Ts.TypeChecker) => A) =>
  Effect.serviceWith(Parser, (a) => f(a.checker))

const rootNames = (baseDir: string) =>
  pipe(
    Fs.walk(baseDir),
    Stream.filter((a) => a.endsWith(".ts")),
    Stream.runCollect,
    Effect.map(Collection.toArray),
  )

const sourceFiles = Stream.serviceWithStream(Parser, ({ program }) =>
  pipe(
    Stream.fromCollection(program.getSourceFiles()),
    Stream.filter((a) => !a.isDeclarationFile),
  ),
)

const nodesFromSourceFile = (
  sourceFile: Ts.Node,
): Stream.Stream<never, never, Ts.Node> =>
  pipe(
    Stream.async<never, never, Ts.Node>((emit) => {
      Ts.forEachChild(sourceFile, (a) => {
        emit.single(a)
      })
      emit.end()
    }, Infinity),
    Stream.flatMap((a) =>
      Ts.isModuleDeclaration(a) ? nodesFromSourceFile(a) : Stream.sync(() => a),
    ),
  )

const getSymbolType = (symbol: Ts.Symbol) =>
  Effect.serviceWith(Parser, ({ checker }) =>
    checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!),
  )

const getSymbol = (node: Ts.Node) =>
  Effect.serviceWith(Parser, ({ checker }) =>
    pipe(
      Maybe.Do,
      Maybe.bind("sourceFile", () => Maybe.some(node.getSourceFile())),
      Maybe.bind("symbol", () =>
        Maybe.fromNullable(checker.getSymbolAtLocation(node)),
      ),
      Maybe.bind("type", ({ symbol }) =>
        pipe(
          Maybe.fromNullable(symbol.valueDeclaration),
          Maybe.map((a) => checker.getTypeOfSymbolAtLocation(symbol, a)),
        ),
      ),
    ),
  )

const getReturnType = (signature: Ts.Signature) =>
  Effect.serviceWith(Parser, ({ checker }) =>
    checker.getReturnTypeOfSignature(signature),
  )

const getSymbolStream = (node: Ts.Node) =>
  pipe(
    getSymbol(node),
    Effect.flatMap(Effect.fromMaybe),
    Stream.fromEffectMaybe,
  )

const nodes = pipe(sourceFiles, Stream.flatMap(nodesFromSourceFile))

const isNodeExported = (node: Ts.Node): boolean =>
  (Ts.getCombinedModifierFlags(node as Ts.Declaration) &
    Ts.ModifierFlags.Export) !==
    0 || node.parent.kind === Ts.SyntaxKind.SourceFile

Ts.isArrowFunction

const exportedNodes = pipe(nodes, Stream.filter(isNodeExported))

const classes = pipe(exportedNodes, Stream.filter(Ts.isClassDeclaration))

const variables = pipe(exportedNodes, Stream.filter(Ts.isVariableStatement))

const constVariables = pipe(
  variables,
  Stream.filter((a) => (a.declarationList.flags & Ts.NodeFlags.Const) !== 0),
)

const constVariableDeclarations = pipe(
  constVariables,
  Stream.flatMap((a) => Stream.fromCollection(a.declarationList.declarations)),
)

const constVariableSymbols = pipe(
  constVariableDeclarations,
  Stream.flatMap((a) => getSymbolStream(a.name)),
)

const functions = pipe(exportedNodes, Stream.filter(Ts.isFunctionDeclaration))
const functionSymbols = pipe(
  functions,
  Stream.filter((a) => !!a.name),
  Stream.flatMap((a) => getSymbolStream(a.name!)),
)
const constants = pipe(
  constVariableSymbols,
  Stream.filter((a) => a.type.getCallSignatures().length === 0),
)

const interfaces = pipe(exportedNodes, Stream.filter(Ts.isInterfaceDeclaration))

const typeAliases = pipe(
  exportedNodes,
  Stream.filter(Ts.isTypeAliasDeclaration),
)

const enums = pipe(exportedNodes, Stream.filter(Ts.isEnumDeclaration))

// Callables
const callables = pipe(
  constVariableSymbols,
  Stream.merge(functionSymbols),
  Stream.bind("callSignature", ({ type }) =>
    Stream.fromCollection(type.getCallSignatures()),
  ),
  Stream.bind("returnType", ({ callSignature }) =>
    Stream.fromEffect(getReturnType(callSignature)),
  ),
)

const isFluentCandidate = (signature: Ts.Signature) =>
  pipe(
    Maybe.fromNullable(signature.getParameters()[0]),
    Maybe.filter((a) => ["self", "_self"].includes(a.name)),
    Maybe.isSome,
  )

const isGetter = (signature: Ts.Signature) =>
  isFluentCandidate(signature) && signature.getParameters().length === 1

const isPipeableReturnType = (type: Ts.Type) =>
  type.getCallSignatures().some(isGetter)

export const getters = pipe(
  callables,
  Stream.filter((a) => isGetter(a.callSignature)),
  Stream.bind("selfType", (a) =>
    pipe(
      getSymbolType(a.callSignature.getParameters()[0]),
      Effect.flatMap(getTypeInformation),
      Stream.fromEffect,
    ),
  ),
)

export const pipeables = pipe(
  callables,
  Stream.filter((a) => isPipeableReturnType(a.returnType)),
  Stream.bind("returnCallSignature", (a) =>
    Stream.sync(() => a.returnType.getCallSignatures().find(isGetter)!),
  ),
  Stream.bind("selfType", (a) =>
    pipe(
      getSymbolType(a.returnCallSignature.getParameters()[0]),
      Effect.flatMap(getTypeInformation),
      Stream.fromEffect,
    ),
  ),
)

export const constructors = pipe(
  callables,
  Stream.filter(
    (a) =>
      !isFluentCandidate(a.callSignature) &&
      a.returnType.getCallSignatures().length === 0,
  ),
  Stream.bind("selfType", (a) =>
    Stream.fromEffect(getTypeInformation(a.callSignature.getReturnType())),
  ),
)

// Static
const nonVariableStatics = pipe(
  classes,
  Stream.merge(interfaces),
  Stream.merge(typeAliases),
  Stream.merge(enums),
  Stream.filter((a) => !!a.name),
  Stream.map((a) => ({
    declaration: a,
    name: a.name!.escapedText,
    sourceFile: a.getSourceFile(),
  })),
)

export const statics = pipe(
  nonVariableStatics,
  Stream.merge(
    pipe(
      constants,
      Stream.map((a) => ({
        ...a,
        name: a.symbol.name,
      })),
    ),
  ),
  Stream.bind("namespace", (a) =>
    Stream.fromEffect(getNamespaceFromSourceFile(a.sourceFile)),
  ),
)

const getSourceFileFromType = (type: Ts.Type) =>
  type.symbol.valueDeclaration!.getSourceFile()

const getNamespaceFromSourceFile = (file: Ts.SourceFile) =>
  pipe(
    file.fileName.includes("/node_modules/")
      ? getExternalModulePath(file.fileName)
      : getInternalModulePath(file.fileName),
    Effect.map((path) =>
      path
        .replace(/\/definition\/.*/, "")
        .replace(/^@/, "")
        .replace(/\.(ts|js)x?$/, "")
        .replace(/\/index$/, ""),
    ),
  )

const getExternalModulePath = (file: string) =>
  Effect.sync(() => file.match(/.*\/node_modules\/(.*)/)![1])

const getInternalModulePath = (file: string) =>
  Effect.serviceWith(
    Parser,
    ({ baseDir, moduleName }) =>
      `${moduleName}/${Path.relative(baseDir, file)}`,
  )

const getTypeInformation = (type: Ts.Type) =>
  pipe(
    Effect.sync(() => ({
      type,
      name: type.symbol.name,
      sourceFile: getSourceFileFromType(type),
    })),
    Effect.bind("namespace", (a) => getNamespaceFromSourceFile(a.sourceFile)),
  )
