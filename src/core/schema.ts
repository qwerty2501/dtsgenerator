import { OpenAPIV3 } from 'openapi-types';
import * as JsonPointer from '../jsonPointer';
import SchemaId from './schemaId';

export type JsonSchemaContent = JsonSchemaOrg.Draft04.Schema | JsonSchemaOrg.Draft07.Schema;
export type SchemaContent = JsonSchemaContent | OpenAPIV3SchemaContentObject;
export type JsonScehmaContentObject = JsonSchemaOrg.Draft04.Schema | JsonSchemaOrg.Draft07.SchemaObject;
export type SchemaContentObject = JsonScehmaContentObject | OpenAPIV3SchemaContentObject;
export type OpenAPIV3SchemaContentObject = OpenAPIV3OperationObject;
export type SchemaType = 'Draft04' | 'Draft07';

export const openAPIV3Operation: unique symbol = Symbol();
export interface OpenAPIV3OperationObject extends OpenAPIV3.OperationObject {
    namespaces: string[];
    [openAPIV3Operation]: any;
}


export interface Schema {
    type: SchemaType;
    openApiVersion?: 2 | 3;
    id: SchemaId;
    content: SchemaContent;
    rootSchema?: Schema;
}

export interface JsonSchema extends Schema {
    content: JsonSchemaContent;
}
export interface NormalizedJsonSchema extends Schema {
    content: JsonScehmaContentObject;
}

export function parseSchema(content: any, url?: string): Schema {
    const { type, openApiVersion } = selectSchemaType(content);
    if (url != null) {
        setId(type, content, url);
    }
    const id = getId(type, content);
    return {
        type,
        openApiVersion,
        id: id ? new SchemaId(id) : SchemaId.empty,
        content,
    };
}

export function getSubSchema(rootSchema: Schema, pointer: string, id?: SchemaId): Schema {
    const content = JsonPointer.get(rootSchema.content, JsonPointer.parse(pointer));
    if (id == null) {
        const subId = getId(rootSchema.type, content);
        const getParentIds = (s: Schema, result: string[]): string[] => {
            result.push(s.id.getAbsoluteId());
            return s.rootSchema == null ? result : getParentIds(s.rootSchema, result);
        };
        if (subId) {
            id = new SchemaId(subId, getParentIds(rootSchema, []));
        } else {
            id = new SchemaId(pointer, getParentIds(rootSchema, []));
        }
    }
    return {
        type: rootSchema.type,
        id,
        content,
        rootSchema,
    };
}

export function getId(type: SchemaType, content: any): string | undefined {
    return content[getIdPropertyName(type)];
}
export function checkOpenAPIV3SchemaContentObject(schemaContentObject: SchemaContentObject): schemaContentObject is OpenAPIV3SchemaContentObject {
    return openAPIV3Operation in schemaContentObject;
}

export function checkOpenAPIV3RefereunceObject(obj: OpenAPIV3.ReferenceObject | any): obj is OpenAPIV3.ReferenceObject {
    return typeof (obj as OpenAPIV3.ReferenceObject).$ref === 'string';
}

function setId(type: SchemaType, content: any, id: string): void {
    const key = getIdPropertyName(type);
    if (content[key] == null) {
        content[key] = id;
    }
}
function getIdPropertyName(type: SchemaType): string {
    switch (type) {
        case 'Draft04': return 'id';
        case 'Draft07': return '$id';
    }
}


export function searchAllSubSchema(schema: Schema, onFoundSchema: (subSchema: Schema) => void, onFoundReference: (refId: SchemaId) => void): void {
    const walkArray = (array: SchemaContent[] | undefined, paths: string[], parentIds: string[]): void => {
        if (array == null) {
            return;
        }
        array.forEach((item, index) => {
            walk(item, paths.concat(index.toString()), parentIds);
        });
    };
    const walkObject = (obj: { [name: string]: SchemaContent; } | undefined, paths: string[], parentIds: string[]): void => {
        if (obj == null) {
            return;
        }
        Object.keys(obj).forEach((key) => {
            const sub = obj[key];
            if (sub != null) {
                walk(sub, paths.concat(key), parentIds);
            }
        });
    };
    const walkMaybeArray = (item: SchemaContent | SchemaContent[] | undefined, paths: string[], parentIds: string[]): void => {
        if (Array.isArray(item)) {
            walkArray(item, paths, parentIds);
        } else {
            walk(item, paths, parentIds);
        }
    };


    const findId = (s: SchemaContent, id: string | undefined, parentIds: string[]): string[] => {
        if (id && typeof id === 'string') {
            const schemaId = new SchemaId(id, parentIds);
            const subSchema: Schema = {
                type: schema.type,
                id: schemaId,
                content: s,
                rootSchema: schema,
            };
            onFoundSchema(subSchema);
            return parentIds.concat([schemaId.getAbsoluteId()]);
        }

        return parentIds;
    };

    const findRef = (refObject: { $ref?: string | undefined }, parentIds: string[]) => {
        if (typeof refObject.$ref === 'string') {
            const schemaId = new SchemaId(refObject.$ref, parentIds);
            refObject.$ref = schemaId.getAbsoluteId();
            onFoundReference(schemaId);
        }
    };

    const walkOpenAPIV3Operation = (op: OpenAPIV3.OperationObject | undefined, method: string, path: string, paths: string[], parentIds: string[]) => {
        if (op == null || typeof op !== 'object') {
            return;
        }
        const operation: OpenAPIV3OperationObject = { ...op, namespaces: ['$'].concat(path.split('/').map((s) => s.replace(/^$/, '\$\$').replace(/^{(.*)}$/, '\$$1')), method), [openAPIV3Operation]: null };
        const id = getId(schema.type, operation);
        parentIds = findId(operation, id, parentIds);

        const obj = op as any;
        for (const key of Object.keys(obj)) {
            const field = obj[key];
            if (key === '$ref') {
                findRef(field, parentIds);
            }
        }
    };


    const walkOpenAPIV3Paths = (pathObject: OpenAPIV3.PathObject, paths: string[], parentIds: string[]) => {
        if (pathObject == null || typeof pathObject !== 'object') {
            return;
        }
        for (const path of Object.keys(pathObject)) {
            const pathItem = pathObject[path];
            for (const operation of [['get', pathItem.get], ['post', pathItem.post], ['put', pathItem.put], ['patch', pathItem.patch], ['delete', pathItem.delete], ['head', pathItem.head]]) {
                const method = operation[0] as string;
                walkOpenAPIV3Operation(operation[1] as OpenAPIV3.OperationObject, method, path, paths.concat(path, method), parentIds);
            }
        }
    };

    const walk = (s: SchemaContent | undefined, paths: string[], parentIds: string[]) => {

        if (s == null || typeof s !== 'object') {
            return;
        }

        const id = getId(schema.type, s);
        parentIds = findId(s, id, parentIds);

        const jsco = s as JsonScehmaContentObject;
        findRef(jsco, parentIds);
        walkArray(jsco.allOf, paths.concat('allOf'), parentIds);
        walkArray(jsco.anyOf, paths.concat('anyOf'), parentIds);
        walkArray(jsco.oneOf, paths.concat('oneOf'), parentIds);
        walk(jsco.not, paths.concat('not'), parentIds);

        walkMaybeArray(jsco.items, paths.concat('items'), parentIds);
        walk(jsco.additionalItems, paths.concat('additionalItems'), parentIds);
        walk(jsco.additionalProperties, paths.concat('additionalProperties'), parentIds);
        walkObject(jsco.definitions, paths.concat('definitions'), parentIds);
        walkObject(jsco.properties, paths.concat('properties'), parentIds);
        walkObject(jsco.patternProperties, paths.concat('patternProperties'), parentIds);
        walkMaybeArray(jsco.dependencies, paths.concat('dependencies'), parentIds);
        if (schema.type === 'Draft07') {
            if ('propertyNames' in s) {
                walk(s.propertyNames, paths.concat('propertyNames'), parentIds);
                walk(s.contains, paths.concat('contains'), parentIds);
                walk(s.if, paths.concat('if'), parentIds);
                walk(s.then, paths.concat('then'), parentIds);
                walk(s.else, paths.concat('else'), parentIds);
            }
        }
        if (schema.openApiVersion === 3) {
            const obj = s as any;
            if (obj.paths) {
                walkOpenAPIV3Paths(obj.paths, paths.concat('paths'), parentIds);
            }

            if (obj.headers) {
                walkObject(obj.headers, paths.concat('headers'), parentIds);
            }

            if (obj.schema) {
                walk(obj.schema, paths.concat('schema'), parentIds);
            }


            if (obj.components) {
                walkObject(obj.components, paths.concat('components'), parentIds);
            }

            if (obj.schemas) {
                walkObject(obj.schemas, paths.concat('schemas'), parentIds);
            }

            if (obj.parameters) {
                walkObject(obj.parameters, paths.concat('parameters'), parentIds);
            }

            if (obj.requestBodies) {
                walkObject(obj.requestBodies, paths.concat('requestBodies'), parentIds);
            }
        }
    };

    walk(schema.content, ['#'], []);
}

function selectSchemaType(content: any): { type: SchemaType; openApiVersion?: 2 | 3; } {
    if (content.$schema) {
        const schema = content.$schema;
        const match = schema.match(/http\:\/\/json-schema\.org\/draft-(\d+)\/schema#?/);
        if (match) {
            const version = Number(match[1]);
            if (version <= 4) {
                return { type: 'Draft04' };
            } else {
                return { type: 'Draft07' };
            }
        }
    }
    if (content.swagger === '2.0') {
        // Add `id` property in #/definitions/*
        if (content.definitions) {
            setSubIds(content.definitions, 'Draft04', 'definitions');
        }
        return {
            type: 'Draft04',
            openApiVersion: 2,
        };
    }
    if (content.openapi) {
        const openapi = content.openapi;
        if (/^3\.\d+\.\d+$/.test(openapi)) {
            if (content.paths) {
                setSubIds(content.paths, 'Draft07', 'paths');
            }
            // Add `id` property in #/components/schemas/*
            if (content.components && content.components.schemas) {
                setSubIds(content.components.schemas, 'Draft07', 'components/schemas');
            }
            return {
                type: 'Draft07',
                openApiVersion: 3,
            };
        }
    }
    // fallback to old version JSON Schema
    return { type: 'Draft04' };
}
function setSubIds(obj: any, type: SchemaType, prefix: string): void {
    Object.keys(obj).forEach((key) => {
        const sub = obj[key];
        if (sub != null) {
            setId(type, sub, `#/${prefix}/${key}`);
        }
    });
}

