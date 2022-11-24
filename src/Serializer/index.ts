import { Parser, pipe, Stream } from "tsplus-gen/common.js"
import { Symbol } from "typescript"

export type DefinitionKind =
  | "const"
  | "function"
  | "interface"
  | "class"
  | "type"

export interface Definition {
  readonly definitionName: string
  readonly definitionKind: DefinitionKind
  readonly extensions: ReadonlyArray<Extension>
}

export type ExtensionKind = "static" | "pipeable" | "fluent" | "getter" | "type"

export interface Extension {
  readonly kind: ExtensionKind
  readonly typeName: string
  readonly name: string
}

type DefinitionTuple = readonly [module: string, definition: Definition]

interface ParserOutput {
  kind: DefinitionKind
  typeName: string
  namespace: string
  symbol: Symbol
}

const labeledParserOutput = <
  R,
  E,
  A extends ParserOutput,
  K extends ExtensionKind,
>(
  kind: K,
  self: Stream.Stream<R, E, A>,
) =>
  pipe(
    self,
    Stream.map(
      (a): DefinitionTuple => [
        a.namespace,
        {
          definitionName: a.symbol.name,
          definitionKind: a.kind,
          extensions: [
            {
              kind,
              typeName: a.typeName,
              name: a.symbol.name,
            },
          ],
        },
      ],
    ),
  )

const fluents = labeledParserOutput("fluent", Parser.fluents)
const getters = labeledParserOutput("getter", Parser.getters)
const pipeables = labeledParserOutput("pipeable", Parser.pipeables)
const statics = labeledParserOutput("static", Parser.statics)
const types = labeledParserOutput("type", Parser.types)

export const definitions = pipe(
  fluents,
  Stream.merge(getters),
  Stream.merge(pipeables),
  Stream.merge(statics),
  Stream.merge(types),
  Stream.runFold(
    {} as Record<string, Definition[]>,
    (acc, [namespace, definition]) => ({
      ...acc,
      [namespace]: [...(acc[namespace] || []), definition],
    }),
  ),
)
