import Debug from 'debug';
import { OpenAPIV3 } from 'openapi-types';
import ReferenceResolver from './referenceResolver';
import { checkOpenAPIV3RefereunceObject, checkOpenAPIV3SchemaContentObject, getSubSchema, JsonSchema, JsonSchemaContent, NormalizedJsonSchema, OpenAPIV3OperationObject, OpenAPIV3SchemaContentObject, Schema } from './schema';
import SchemaConvertor from './schemaConvertor';
import SchemaId from './schemaId';
import * as utils from './utils';

const debug = Debug('dtsgen');
const typeMarker = Symbol();

export default class DtsGenerator {

    private currentSchema!: NormalizedJsonSchema;

    constructor(private resolver: ReferenceResolver, private convertor: SchemaConvertor) { }

    public async generate(): Promise<string> {

        debug('generate type definition files.');
        await this.resolver.resolve();
        const schemas = Array.from(this.resolver.getAllRegisteredSchema()).map((s) => {
            return this.resolveOpenAPIV3SchemaContent(s);
        }).reduce((prv, target) => {
            return prv.concat(target);
        });

        // for after resolveOpenAPIV3SchemaContent
        await this.resolver.resolve();

        const map = this.convertor.buildSchemaMergedMap(schemas, typeMarker);
        this.convertor.start();
        this.walk(map);
        const result = this.convertor.end();

        return result;
    }

    private walk(map: any): void {
        const keys = Object.keys(map).sort();
        for (const key of keys) {
            const value = map[key];
            if (value.hasOwnProperty(typeMarker)) {
                const schema = value[typeMarker] as Schema;
                debug(`  walk doProcess: schemaId=${schema.id.getAbsoluteId()}`);
                this.walkSchema(schema);
                delete value[typeMarker];
            }
            if (typeof value === 'object' && Object.keys(value).length > 0) {
                this.convertor.startNest(key);
                this.walk(value);
                this.convertor.endNest();
            }
        }
    }

    private walkSchema(schema: Schema): void {

        const normalized = this.normalizeContent(schema);
        this.currentSchema = normalized;
        this.convertor.outputComments(normalized);

        const type = normalized.content.type;
        switch (type) {
            case 'object':
            case 'any':
                return this.generateTypeModel(normalized);
            case 'array':
                return this.generateTypeCollection(normalized);
            default:
                return this.generateDeclareType(normalized);
        }

    }

    private normalizeContent(schema: JsonSchema, pointer?: string): NormalizedJsonSchema {
        if (pointer != null) {
            schema = getSubSchema(schema, pointer);
        }
        let content = schema.content;
        if (typeof content === 'boolean') {
            content = content ? {} : { not: {} };

        } else {

            if (content.allOf) {
                const work = content;
                for (let sub of content.allOf) {
                    if (typeof sub === 'object' && sub.$ref) {
                        const ref = this.resolver.dereference(sub.$ref);
                        sub = this.normalizeContent(ref).content;
                    }
                    utils.mergeSchema(work, sub);
                }
                delete content.allOf;
                content = work;
            }
            const types = content.type;
            if (types === undefined && (content.properties || content.additionalProperties)) {
                content.type = 'object';
            } else if (Array.isArray(types)) {
                const reduced = utils.reduceTypes(types);
                content.type = reduced.length === 1 ? reduced[0] : reduced;
            }

        }
        return Object.assign({}, schema, { content });
    }
    private resolveOpenAPIV3SchemaContent(schema: Schema): JsonSchema[] {
        if (checkOpenAPIV3SchemaContentObject(schema.content)) {
            return this.resolveOpenAPIV3SchemaContentObject(schema, schema.content);
        } else {
            return [schema];
        }
    }
    private resolveOpenAPIV3SchemaContentObject(schema: Schema, content: OpenAPIV3SchemaContentObject): JsonSchema[] {
        const work = content as OpenAPIV3OperationObject;
        const results: NormalizedJsonSchema[] = [];
        const baseId = schema.id.getAbsoluteId();
        const requestSchema = Object.assign({}, schema, {
            id: new SchemaId(baseId.concat('/', 'request'), []),
            content: {
                properties: {},
                required: [],
                type: 'object',
            } as JsonSchemaOrg.Draft04.Schema,
        });
        if (work.parameters) {
            const parameters = work.parameters.map(this.resolveOpenAPIV3Object);

            const normalizeSchema = (s: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined) => {
                s = Object.assign({}, s);
                if (checkOpenAPIV3RefereunceObject(s)) {
                    s = this.resolver.dereference(s.$ref).content as OpenAPIV3.SchemaObject | undefined;
                }
                if (s !== undefined) {
                    return Object.assign({}, s, { type: s.type !== 'object' && s.type !== 'array' ? s.type : 'string' });
                }
                return {
                    type: 'string',
                } as OpenAPIV3.SchemaObject;
            };

            const normalizeParameter = (request: NormalizedJsonSchema, r: NormalizedJsonSchema[], params: OpenAPIV3.ParameterObject[], paramName: string) => {
                const filterdParams = params.filter((parameter) => parameter.in === paramName);
                if (filterdParams.length) {
                    const parameterObject = params.reduce((prev: JsonSchemaOrg.Draft04.Schema, target) => {
                        const next = Object.assign({}, prev);

                        if (next.properties) {
                            const s = normalizeSchema(target.schema);
                            next.properties[target.name] = s;
                            if (target.required && next.required) {
                                next.required = next.required.concat(target.name);
                            }
                        }

                        return next;
                    },
                        {
                            type: 'object',
                            properties: {},
                            required: [],
                        } as JsonSchemaOrg.Draft04.Schema);


                    const propertyName = paramName + 'Param';
                    const parameterSchema = Object.assign({}, schema, {
                        id: new SchemaId(baseId.concat('/', paramName + 'Parameter'), []),
                        content: parameterObject,
                    });

                    if (request.content.properties) {
                        request.content.properties[propertyName] = {
                            $ref: parameterSchema.id.getAbsoluteId(),
                        };
                        if (request.content.required && parameterSchema.content.required) {
                            request.content.required = parameterSchema.content.required.length > 0 ? request.content.required.concat(propertyName) : request.content.required;
                        }
                    }
                    this.resolver.addSchema(parameterSchema);
                    this.resolver.addReference(parameterSchema.id);
                    r.push(parameterSchema);
                }
            };

            normalizeParameter(requestSchema, results, parameters, 'path');
            normalizeParameter(requestSchema, results, parameters, 'query');
            normalizeParameter(requestSchema, results, parameters, 'header');
            normalizeParameter(requestSchema, results, parameters, 'cookie');

        }

        if (work.requestBody) {
            const requestBody = this.resolveOpenAPIV3Object(work.requestBody);
            const mediaKeys = Object.keys(requestBody.content);
            const singleMedia = mediaKeys.length === 1;
            for (const mediaType of mediaKeys) {
                const bodyContent = requestBody.content[mediaType];
                if (bodyContent.schema) {
                    const bodyContentSchema = this.resolveOpenAPIV3Object(bodyContent.schema);
                    const bodyTypeName = DtsGenerator.mediaTypeToTypeNamePrefix(mediaType);
                    const bodySchema = Object.assign({}, requestSchema, {
                        id: new SchemaId(baseId.concat('/', singleMedia ? '' : bodyTypeName, 'RequestBody')),
                        content: bodyContentSchema,
                    } as JsonSchema);
                    this.resolver.addSchema(bodySchema);
                    results.push(bodySchema);

                    const rs = Object.assign({}, requestSchema, {
                        id: new SchemaId(baseId.concat('/', singleMedia ? '' : bodyTypeName + 'Request')),
                    } as Schema);
                    if (rs.content.properties) {
                        rs.content.properties.body = {
                            $ref: bodySchema.id.getAbsoluteId(),
                        };
                        if (bodyContentSchema.required && bodyContentSchema.required.length > 0 && rs.content.required) {
                            rs.content.required = rs.content.required.concat('body');
                        }

                        this.resolver.addReference(bodySchema.id);
                    }
                    results.push(rs);
                }
            }

        } else if (requestSchema.content.properties && Object.keys(requestSchema.content.properties).length > 0) {
            results.push(requestSchema);
        }

        return results;
    }

    private static mediaTypeToTypeNamePrefix(mediaType: string): string {
        switch (mediaType) {
            case 'application/json':
                return 'json';
            case 'application/xml':
                return 'xml';
            case 'application/x-www-form-urlencoded':
                return 'form';
            case 'text/plain':
                return 'text';
            default:
                return mediaType;
        }
    }

    private resolveOpenAPIV3Object<T>(obj: OpenAPIV3.ReferenceObject | T): T {
        return checkOpenAPIV3RefereunceObject(obj) ? this.resolver.dereference(obj.$ref).content as T : obj;
    }

    private generateDeclareType(schema: NormalizedJsonSchema): void {
        this.convertor.outputExportType(schema.id);
        this.generateTypeProperty(schema, true);
    }

    private generateTypeModel(schema: NormalizedJsonSchema): void {
        this.convertor.startInterfaceNest(schema.id);
        if (schema.content.type === 'any') {
            this.convertor.outputRawValue('[name: string]: any; // any', true);
        }
        this.generateProperties(schema);
        this.convertor.endInterfaceNest();
    }

    private generateTypeCollection(schema: NormalizedJsonSchema): void {
        this.convertor.outputExportType(schema.id);
        this.generateArrayTypeProperty(schema, true);
    }

    private generateProperties(baseSchema: NormalizedJsonSchema): void {
        const content = baseSchema.content;
        if (content.additionalProperties) {
            this.convertor.outputRawValue('[name: string]: ');

            const schema = this.normalizeContent(baseSchema, '/additionalProperties');
            if (content.additionalProperties === true) {
                this.convertor.outputStringTypeName(schema, 'any', true);
            } else {
                this.generateTypeProperty(schema, true);
            }

        }
        if (content.properties) {
            for (const propertyName of Object.keys(content.properties)) {
                const schema = this.normalizeContent(baseSchema, '/properties/' + propertyName);
                this.convertor.outputComments(schema);
                this.convertor.outputPropertyAttribute(schema);
                this.convertor.outputPropertyName(schema, propertyName, baseSchema.content.required);
                this.generateTypeProperty(schema);
            }
        }
    }
    private generateTypeProperty(schema: NormalizedJsonSchema, terminate = true): void {
        const content = schema.content;
        if (content.$ref) {
            const ref = this.resolver.dereference(content.$ref);
            if (ref.id == null) {
                throw new Error('target referenced id is nothing: ' + content.$ref);
            }
            this.convertor.outputTypeIdName(this.normalizeContent(ref), this.currentSchema, terminate);
            return;
        }
        if (content.anyOf || content.oneOf) {
            this.generateArrayedType(schema, content.anyOf, '/anyOf/', terminate);
            this.generateArrayedType(schema, content.oneOf, '/oneOf/', terminate);
            return;
        }
        if (content.enum) {
            this.convertor.outputArrayedType(schema, content.enum, (value) => {
                if (content.type === 'integer') {
                    this.convertor.outputRawValue('' + value);
                } else {
                    this.convertor.outputRawValue(`"${value}"`);
                }
            }, terminate);
        } else if ('const' in content) {
            const value = content.const;
            if (content.type === 'integer') {
                this.convertor.outputStringTypeName(schema, '' + value, terminate);
            } else {
                this.convertor.outputStringTypeName(schema, `"${value}"`, terminate);
            }
        } else {
            this.generateType(schema, terminate);
        }
    }
    private generateArrayedType(baseSchema: NormalizedJsonSchema, contents: JsonSchemaContent[] | undefined, path: string, terminate: boolean): void {
        if (contents) {
            this.convertor.outputArrayedType(baseSchema, contents, (_content, index) => {
                const schema = this.normalizeContent(baseSchema, path + index);
                if (schema.id.isEmpty()) {
                    this.generateTypeProperty(schema, false);
                } else {
                    this.convertor.outputTypeIdName(schema, this.currentSchema, false);
                }


            }, terminate);
        }
    }


    private generateArrayTypeProperty(schema: NormalizedJsonSchema, terminate = true): void {
        const items = schema.content.items;
        const minItems = schema.content.minItems;
        if (items == null) {
            this.convertor.outputStringTypeName(schema, 'any[]', terminate);
        } else if (!Array.isArray(items)) {
            this.generateTypeProperty(this.normalizeContent(schema, '/items'), false);
            this.convertor.outputStringTypeName(schema, '[]', terminate);
        } else if (items.length === 0 && minItems === undefined) {
            this.convertor.outputStringTypeName(schema, 'any[]', terminate);
        } else {
            const effectiveMaxItems = 1 + Math.max(minItems || 0, items.length);
            for (
                let unionIndex = minItems === undefined ? 1 : minItems;
                unionIndex <= effectiveMaxItems;
                unionIndex++
            ) {
                this.convertor.outputRawValue('[');
                for (let i = 0; i < unionIndex; i++) {
                    if (i > 0) {
                        this.convertor.outputRawValue(', ');
                    }
                    if (i < items.length) {
                        const type = this.normalizeContent(schema, '/items/' + i);
                        if (type.id.isEmpty()) {
                            this.generateTypeProperty(type, false);
                        } else {
                            this.convertor.outputTypeIdName(type, this.currentSchema, false);
                        }
                    } else {
                        if (i < effectiveMaxItems - 1) {
                            this.convertor.outputStringTypeName(schema, 'Object', false, false);
                        } else {
                            this.convertor.outputStringTypeName(schema, 'any', false, false);
                        }
                    }
                }
                this.convertor.outputRawValue(']');
                if (unionIndex < effectiveMaxItems) {
                    this.convertor.outputRawValue(' | ');
                }
            }
            this.convertor.outputStringTypeName(schema, '', terminate);
        }
    }

    private generateType(schema: NormalizedJsonSchema, terminate: boolean, outputOptional = true): void {
        const type = schema.content.type;
        if (type == null) {
            this.convertor.outputPrimitiveTypeName(schema, 'any', terminate, outputOptional);
        } else if (typeof type === 'string') {
            this.generateTypeName(schema, type, terminate, outputOptional);
        } else {
            const types = utils.reduceTypes(type);
            if (types.length <= 1) {
                schema.content.type = types[0];
                this.generateType(schema, terminate, outputOptional);
            } else {
                this.convertor.outputArrayedType(schema, types, (t) => {
                    this.generateTypeName(schema, t, false, false);
                }, terminate);
            }
        }
    }
    private generateTypeName(schema: NormalizedJsonSchema, type: string, terminate: boolean, outputOptional = true): void {
        const tsType = utils.toTSType(type, schema.content);
        if (tsType) {
            this.convertor.outputPrimitiveTypeName(schema, tsType, terminate, outputOptional);
        } else if (type === 'object') {
            this.convertor.startTypeNest();
            this.generateProperties(schema);
            this.convertor.endTypeNest(terminate);
        } else if (type === 'array') {
            this.generateArrayTypeProperty(schema, terminate);
        } else {
            throw new Error('unknown type: ' + type);
        }
    }
}
