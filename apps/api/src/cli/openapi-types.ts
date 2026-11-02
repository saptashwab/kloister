import ts from 'typescript';

/**
 * Build-time helper for the OpenAPI generator: reads the API's TypeScript
 * sources with the compiler and turns each controller method's declared
 * return type into an OpenAPI schema. Response shapes are interfaces from
 * `@kloister/shared` that decorators cannot see, so reading the declared
 * types keeps the reference in step with the code without hand-written
 * copies. Never imported by the running backend; packaging leaves it out.
 */

/** An OpenAPI 3.0 schema object (the subset this generator writes). */
export type SchemaObject = Record<string, unknown>;

/** What a controller method answers, read from its declared return type. */
export type MethodResponse =
  { kind: 'json'; schema: SchemaObject } | { kind: 'empty' } | { kind: 'file' };

/** Facts about one controller method. */
export interface MethodFacts {
  /** First paragraph of the method's doc comment. */
  summary: string;
  /** The response body. */
  response: MethodResponse;
  /** True when the method takes a raw file body named by the `x-file-name` header. */
  upload: boolean;
}

/** Facts about one controller class. */
export interface ControllerFacts {
  /** First paragraph of the class doc comment. */
  description: string;
  /** Methods by name. */
  methods: Map<string, MethodFacts>;
}

/**
 * Reads controller return types and shared interfaces from one TypeScript
 * program and collects every named type it meets as a reusable component
 * schema in {@link TypeSchemaReader.schemas}.
 */
export class TypeSchemaReader {
  /** Named component schemas collected so far, by name. */
  readonly schemas: Record<string, SchemaObject> = {};
  private readonly checker: ts.TypeChecker;
  private readonly classes = new Map<string, ts.ClassDeclaration>();
  private readonly exported = new Map<string, ts.Declaration>();
  /** Named types already given a component name, so equal names never clash. */
  private readonly owners = new Map<string, ts.Symbol>();

  /**
   * Builds the program from the API's build configuration.
   *
   * @param tsconfigPath Absolute path of `apps/api/tsconfig.build.json`.
   * @param reserved Component names already used by request DTO classes;
   *   response types with the same name get a `Response` suffix.
   */
  constructor(
    tsconfigPath: string,
    private readonly reserved: ReadonlySet<string>,
  ) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      tsconfigPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    );
    if (parsed === undefined) throw new Error(`Cannot read ${tsconfigPath}`);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    this.checker = program.getTypeChecker();
    for (const file of program.getSourceFiles()) {
      if (file.fileName.includes('/node_modules/') && !file.fileName.includes('/@kloister/')) {
        continue;
      }
      for (const statement of file.statements) {
        if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
          this.classes.set(statement.name.text, statement);
        }
        if (
          (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
          file.fileName.includes('/shared/')
        ) {
          this.exported.set(statement.name.text, statement);
        }
      }
    }
  }

  /**
   * Describes a controller class and its methods.
   *
   * @param className The class name, as in the operation id.
   * @returns The facts, or undefined when no such class exists.
   */
  controller(className: string): ControllerFacts | undefined {
    const declaration = this.classes.get(className);
    if (declaration?.name === undefined) return undefined;
    const symbol = this.checker.getSymbolAtLocation(declaration.name);
    const methods = new Map<string, MethodFacts>();
    for (const member of declaration.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const signature = this.checker.getSignatureFromDeclaration(member);
      if (signature === undefined) continue;
      const methodSymbol = this.checker.getSymbolAtLocation(member.name);
      methods.set(member.name.text, {
        summary: methodSymbol === undefined ? '' : this.docs(methodSymbol),
        response: this.response(this.checker.getReturnTypeOfSignature(signature)),
        upload: member.parameters.some((parameter) =>
          ts
            .getDecorators(parameter)
            ?.some((decorator) => decorator.expression.getText().includes('FILE_NAME_HEADER')),
        ),
      });
    }
    return { description: symbol === undefined ? '' : this.docs(symbol), methods };
  }

  /**
   * Returns a reference to a type exported by `@kloister/shared`, adding
   * its component schema.
   *
   * @param name The exported interface or type alias.
   * @returns A `$ref` schema.
   */
  shared(name: string): SchemaObject {
    const declaration = this.exported.get(name);
    if (declaration === undefined) throw new Error(`No shared type named ${name}`);
    return this.schema(this.checker.getTypeAtLocation(declaration));
  }

  /**
   * Maps a method's return type to a response.
   *
   * @param type The declared return type.
   * @returns JSON, empty or file.
   */
  private response(type: ts.Type): MethodResponse {
    const awaited = this.checker.getAwaitedType(type) ?? type;
    const parts = awaited.isUnion() ? awaited.types : [awaited];
    // A file route may also return nothing when it has already answered 404.
    if (parts.some((part) => part.getSymbol()?.getName() === 'StreamableFile')) {
      return { kind: 'file' };
    }
    if (parts.every((part) => part.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined))) {
      return { kind: 'empty' };
    }
    return { kind: 'json', schema: this.schema(awaited) };
  }

  /**
   * Converts a TypeScript type to a schema; named interfaces and aliases
   * from the repository become component references.
   *
   * @param type The type.
   * @returns The schema.
   */
  private schema(type: ts.Type): SchemaObject {
    const named = this.componentName(type);
    if (named !== undefined) {
      if (this.schemas[named] === undefined) {
        // Placeholder first, so self-referencing types terminate.
        this.schemas[named] = {};
        const symbol = (type.aliasSymbol ?? type.getSymbol()) as ts.Symbol;
        const body = this.inline(type);
        const description = this.docs(symbol);
        this.schemas[named] = description === '' ? body : { description, ...body };
      }
      return { $ref: `#/components/schemas/${named}` };
    }
    return this.inline(type);
  }

  /**
   * Picks the component name of a type that deserves one: a non-generic
   * interface, class or alias declared in the repository.
   *
   * @param type The type.
   * @returns The name, or undefined to inline the type.
   */
  private componentName(type: ts.Type): string | undefined {
    const symbol =
      type.aliasSymbol !== undefined && (type.aliasTypeArguments?.length ?? 0) === 0
        ? type.aliasSymbol
        : type.aliasSymbol === undefined &&
            type.flags & ts.TypeFlags.Object &&
            !(
              (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference &&
              (this.checker.getTypeArguments(type as ts.TypeReference).length ?? 0) > 0
            ) &&
            ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Interface) !== 0
          ? type.getSymbol()
          : undefined;
    if (symbol === undefined) return undefined;
    const file = symbol.declarations?.[0]?.getSourceFile().fileName ?? '';
    const local = !file.includes('/node_modules/') || file.includes('/@kloister/');
    if (!local || file.includes('/generated/') || symbol.getName() === 'Date') return undefined;
    let name = symbol.getName();
    if (this.reserved.has(name)) name = `${name}Response`;
    const owner = this.owners.get(name);
    if (owner !== undefined && owner !== symbol) {
      throw new Error(`Two response types are both named ${name}; rename one`);
    }
    this.owners.set(name, symbol);
    return name;
  }

  /**
   * Converts a type without giving it a name.
   *
   * @param type The type.
   * @returns The schema.
   */
  private inline(type: ts.Type): SchemaObject {
    const flags = type.flags;
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (flags & ts.TypeFlags.StringLiteral) {
      return { type: 'string', enum: [(type as ts.StringLiteralType).value] };
    }
    if (flags & ts.TypeFlags.NumberLiteral) {
      return { type: 'number', enum: [(type as ts.NumberLiteralType).value] };
    }
    if (flags & ts.TypeFlags.BooleanLiteral) {
      return { type: 'boolean', enum: [this.checker.typeToString(type) === 'true'] };
    }
    if (flags & ts.TypeFlags.StringLike) return { type: 'string' };
    if (flags & ts.TypeFlags.NumberLike) return { type: 'number' };
    if (flags & ts.TypeFlags.BooleanLike) return { type: 'boolean' };
    if (flags & ts.TypeFlags.BigIntLike) return { type: 'string' };
    if (type.isUnion()) return this.union(type.types);
    if (type.getSymbol()?.getName() === 'Date') return { type: 'string', format: 'date-time' };
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
      const items = this.checker.getTypeArguments(type as ts.TypeReference);
      return {
        type: 'array',
        items: items.length === 1 ? this.schema(items[0]) : this.union(items),
      };
    }
    return this.object(type);
  }

  /**
   * Converts a union: literal unions become enums, `null` makes the rest
   * nullable, `undefined` is dropped (the property is optional).
   *
   * @param members The union members.
   * @returns The schema.
   */
  private union(members: readonly ts.Type[]): SchemaObject {
    const nullable = members.some((member) => member.flags & ts.TypeFlags.Null);
    let rest = members.filter(
      (member) =>
        !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)),
    );
    // `boolean` is the union `true | false`.
    if (rest.length > 1 && rest.every((member) => member.flags & ts.TypeFlags.BooleanLiteral)) {
      rest = [this.checker.getBooleanType()];
    }
    let schema: SchemaObject;
    if (rest.length > 1 && rest.every((member) => member.flags & ts.TypeFlags.StringLiteral)) {
      schema = {
        type: 'string',
        enum: rest.map((member) => (member as ts.StringLiteralType).value),
      };
    } else if (
      rest.length > 1 &&
      rest.every((member) => member.flags & ts.TypeFlags.NumberLiteral)
    ) {
      schema = {
        type: 'number',
        enum: rest.map((member) => (member as ts.NumberLiteralType).value),
      };
    } else if (rest.length === 1) {
      schema = this.schema(rest[0]);
    } else if (rest.length === 0) {
      schema = {};
    } else {
      schema = { oneOf: rest.map((member) => this.schema(member)) };
    }
    if (!nullable) return schema;
    // OpenAPI 3.0 cannot put `nullable` beside `$ref`; wrap the reference.
    return schema['$ref'] === undefined
      ? { ...schema, nullable: true }
      : { allOf: [schema], nullable: true };
  }

  /**
   * Converts an object type: properties, required names and index
   * signatures.
   *
   * @param type The type.
   * @returns The schema.
   */
  private object(type: ts.Type): SchemaObject {
    const properties: Record<string, SchemaObject> = {};
    const required: string[] = [];
    for (const property of this.checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration !== undefined && ts.isMethodDeclaration(declaration)) continue;
      const propertyType = this.checker.getTypeOfSymbol(property);
      if (propertyType.getCallSignatures().length > 0) continue;
      const schema = this.schema(propertyType);
      const description = this.docs(property);
      properties[property.getName()] =
        description === ''
          ? schema
          : schema['$ref'] === undefined
            ? { ...schema, description }
            : { allOf: [schema], description };
      if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.getName());
    }
    const result: SchemaObject = { type: 'object' };
    if (Object.keys(properties).length > 0) result['properties'] = properties;
    if (required.length > 0) result['required'] = required;
    const index =
      this.checker.getIndexTypeOfType(type, ts.IndexKind.String) ??
      this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (index !== undefined) result['additionalProperties'] = this.schema(index);
    return result;
  }

  /**
   * Reads a symbol's doc comment as plain text: `{@link X}` becomes `X` and
   * the text is cut at the first blank line.
   *
   * @param symbol The symbol.
   * @returns The text, or an empty string.
   */
  private docs(symbol: ts.Symbol): string {
    const text = ts.displayPartsToString(symbol.getDocumentationComment(this.checker));
    // Enum aliases repeat "One of the X values." from their own comment; the schema's enum says it.
    return plainDocText(text).replace(/\s*One of the \S+ values\.$/, '');
  }
}

/**
 * Turns doc comment text into one plain paragraph: inline links become their
 * label, line breaks become spaces, and only the first paragraph is kept.
 *
 * @param text Doc comment text.
 * @returns The first paragraph.
 */
export function plainDocText(text: string): string {
  const paragraph = text.replace(/\r/g, '').split(/\n\s*\n/)[0] ?? '';
  return paragraph
    .replace(/\{@link(?:code|plain)?\s+([^}|\s]+)(?:\s*\|\s*|\s+)?([^}]*)\}/g, (_, name, label) =>
      String(label).trim() === '' ? String(name) : String(label).trim(),
    )
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}
