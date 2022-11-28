import {
  Effect,
  Layer,
  Maybe,
  Parser,
  pipe,
  Stream,
  Tag,
} from "tsplus-gen/common.js"
import { Symbol } from "typescript"
import { z } from "zod"

const ExtensionKindBasic = z
  .literal("static")
  .or(z.literal("pipeable"))
  .or(z.literal("fluent"))
  .or(z.literal("getter"))
  .or(z.literal("type"))
type ExtensionKindBasic = z.infer<typeof ExtensionKindBasic>

const ExtensionKind = ExtensionKindBasic.or(z.literal("companion"))
  .or(z.literal("no-inherit"))
  .or(z.literal("operator"))
  .or(z.literal("pipeable-index"))
  .or(z.literal("pipeable-operator"))
  .or(z.literal("unify"))
type ExtensionKind = z.infer<typeof ExtensionKind>

const Extension = z.object({
  kind: ExtensionKind,
  typeName: z.string(),
  name: z.string().optional(),
  priority: z.string().optional(),
})
type Extension = z.infer<typeof Extension>

const KindConfig = z.object({
  include: z.boolean(),
  includeStatic: z.boolean().optional(),
  staticSuffix: z.string().optional(),
  priority: z.number().optional(),
})
type KindConfig = z.infer<typeof KindConfig>

const Namespace = z.object({
  name: z.string(),
  priority: z.number().optional(),
  moduleFileExtension: z.string().optional(),
  modulePriority: z.record(z.number()).optional(),
  exclude: z.array(z.string()).optional(),
  fluent: KindConfig.optional(),
  getter: KindConfig.optional(),
  pipeable: KindConfig.optional(),
  static: KindConfig.optional(),
  type: KindConfig.optional(),
})
type Namespace = z.infer<typeof Namespace>

export const NamespaceList = z.array(Namespace)
export type NamespaceList = z.infer<typeof NamespaceList>

const DefinitionKind = z
  .literal("const")
  .or(z.literal("function"))
  .or(z.literal("interface"))
  .or(z.literal("class"))
  .or(z.literal("type"))
type DefinitionKind = z.infer<typeof DefinitionKind>

const Definition = z.object({
  definitionName: z.string(),
  definitionKind: DefinitionKind,
  extensions: z.array(Extension),
})
type Definition = z.infer<typeof Definition>

const ExtensionTuple = z.union([
  z.tuple([z.string().regex(/^.*#.*$/), ExtensionKind, z.string()]),
  z.tuple([z.string().regex(/^.*#.*$/), ExtensionKind, z.string(), z.number()]),
])
type ExtensionTuple = z.infer<typeof ExtensionTuple>

export const AdditionalExtensions = z.array(ExtensionTuple)
export type AdditionalExtensions = z.infer<typeof AdditionalExtensions>

type DefinitionTuple = readonly [module: string, definition: Definition]

interface ParserOutput {
  kind: DefinitionKind
  typeName: string
  module: string
  symbol: Symbol
}

const make = (
  namespaces: NamespaceList,
  additionalExtensions: AdditionalExtensions = [],
) => {
  const additional = additionalExtensionsRecord(additionalExtensions)

  const makeDefinitions = <
    R,
    E,
    A extends ParserOutput,
    K extends ExtensionKindBasic,
  >(
    kind: K,
    self: Stream.Stream<R, E, A>,
    includeStatic = true,
  ) =>
    pipe(
      self,
      Stream.map((a) => [a, findNamespace(namespaces, a.typeName)] as const),
      Stream.filter(([, ns]) => !!ns),
      Stream.filter(([, ns]) => ns[kind]?.include ?? true),
      Stream.filter(
        ([a, ns]) =>
          !(ns.exclude?.includes(`${a.module}#${a.symbol.name}`) ?? false),
      ),
      Stream.map(([a, config]) =>
        makeDefinitionTuple(kind, a, config, includeStatic),
      ),
    )

  const makeDefinitionTuple = (
    kind: ExtensionKindBasic,
    a: ParserOutput,
    ns: Namespace,
    allowStatic: boolean,
  ): DefinitionTuple => {
    const config = ns[kind]
    const kindPriority = config?.priority?.toString()
    const nsPriority = ns.priority?.toString()
    const modulePriority = findModulePriority(ns, a.module)?.toString()
    const priority = kindPriority ?? nsPriority ?? modulePriority

    const includeStatic = allowStatic && (config?.includeStatic ?? false)

    return [
      `${a.module}${ns.moduleFileExtension || ""}`,
      {
        definitionName: a.symbol.name,
        definitionKind: a.kind,
        extensions: [
          {
            kind,
            typeName: a.typeName,
            name: kind !== "type" ? a.symbol.name : undefined,
            priority,
          },
          ...(includeStatic
            ? [
                {
                  kind: "static",
                  typeName: `${a.typeName}${config?.staticSuffix || ""}`,
                  name: a.symbol.name,
                } as Extension,
              ]
            : []),
          ...(additional[a.typeName]?.[a.symbol.name] ?? []),
        ],
      },
    ]
  }

  const fluents = makeDefinitions("fluent", Parser.fluents)
  const getters = makeDefinitions("getter", Parser.getters)
  const pipeables = makeDefinitions("pipeable", Parser.pipeables)
  const statics = makeDefinitions("static", Parser.statics, false)
  const types = makeDefinitions("type", Parser.types, false)

  const definitions = pipe(
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

  return { definitions }
}

const additionalExtensionsRecord = (tuples: AdditionalExtensions) =>
  tuples
    .map(extensionFromTuple)
    .reduce<Record<string, Record<string, Extension[]>>>(
      (acc, { definitionName, extension }) => {
        if (!acc[extension.typeName]) {
          acc = {
            ...acc,
            [extension.typeName]: {},
          }
        }

        const prev = acc[extension.typeName][definitionName] ?? []

        return {
          ...acc,
          [extension.typeName]: {
            ...acc[extension.typeName],
            [definitionName]: [...prev, extension],
          },
        }
      },
      {},
    )

const extensionFromTuple = ([target, kind, name, priority]: ExtensionTuple) => {
  const [typeName, definitionName] = target.split("#")

  const extension: Extension = {
    typeName,
    kind,
    name,
    priority: priority?.toString(),
  }

  return {
    definitionName,
    extension,
  }
}

const findNamespace = (namespaces: NamespaceList, typeName: string) => {
  const candidates = namespaces.filter((ns) => typeName.startsWith(ns.name))
  candidates.sort((a, b) => b.name.length - a.name.length)
  return candidates[0]!
}

const findModulePriority = (
  { modulePriority = {} }: Namespace,
  module: string,
) => {
  const candidates = Object.entries(modulePriority).filter(([a]) =>
    module.startsWith(a),
  )

  candidates.sort((a, b) => b[0].length - a[0].length)

  return pipe(
    Maybe.fromNullable(candidates[0]),
    Maybe.map((a) => a[1]),
    Maybe.toUndefined,
  )
}

export interface Serializer extends ReturnType<typeof make> {}
export const Serializer = Tag.Tag<Serializer>()
export const makeLayer = (a: NamespaceList, b?: AdditionalExtensions) =>
  Layer.fromValue(Serializer, () => make(a, b))

export const definitions = Effect.serviceWithEffect(
  Serializer,
  (a) => a.definitions,
)
