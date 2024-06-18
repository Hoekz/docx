import JSZip from "jszip";
import { Element, js2xml } from "xml-js";

import { ConcreteHyperlink, ExternalHyperlink, ParagraphChild } from "@file/paragraph";
import { FileChild } from "@file/file-child";
import { IMediaData, Media } from "@file/media";
import { IViewWrapper } from "@file/document-wrapper";
import { File } from "@file/file";
import { IContext } from "@file/xml-components";
import { Relationships } from "@file/relationships";
import { ImageReplacer } from "@export/packer/image-replacer";
import { Relationship, TargetModeType } from "@file/relationships/relationship/relationship";
import { uniqueId } from "@util/convenience-functions";

import { replacer } from "./replacer";
import { findLocationOfText } from "./traverser";
import { toJson } from "./util";
import { appendRelationship, getNextRelationshipIndex } from "./relationship-manager";
import { appendContentType } from "./content-types-manager";
import { appendNumbering } from "./numbering-manager";

// eslint-disable-next-line functional/prefer-readonly-type
type InputDataType = Buffer | string | number[] | Uint8Array | ArrayBuffer | Blob | NodeJS.ReadableStream;

export const PatchType = {
    DOCUMENT: "file",
    PARAGRAPH: "paragraph",
    TEXT: "text",
} as const;

type ParagraphPatch = {
    readonly type: typeof PatchType.PARAGRAPH;
    readonly children: readonly ParagraphChild[];
};

type FilePatch = {
    readonly type: typeof PatchType.DOCUMENT;
    readonly children: readonly FileChild[];
};

type TextPatch = {
    readonly type: typeof PatchType.TEXT;
    readonly text: string;
};

interface IImageRelationshipAddition {
    readonly key: string;
    readonly mediaDatas: readonly IMediaData[];
}

interface IHyperlinkRelationshipAddition {
    readonly key: string;
    readonly hyperlink: { readonly id: string; readonly link: string };
}

interface Numbering {
    readonly abstractNumId: number | string;
    readonly numId: number;
}

class PatchedRelationships extends Relationships {
    // eslint-disable-next-line functional/prefer-readonly-type
    public relationships: IHyperlinkRelationshipAddition[] = [];

    public constructor(public readonly wrapper: PatchDocumentWrapper) {
        super();
    }

    public override createRelationship(
        linkId: string,
        _: string,
        target: string,
        __: (typeof TargetModeType)[keyof typeof TargetModeType],
    ): Relationship {
        // eslint-disable-next-line functional/immutable-data
        this.relationships.push({
            key: this.wrapper.currentKey,
            hyperlink: {
                id: linkId,
                link: target,
            },
        });
        return undefined as unknown as Relationship;
    }
}

export class PatchDocumentWrapper implements IViewWrapper {
    public readonly View = new FileChild("w:document");
    public readonly Relationships = new PatchedRelationships(this);
    // eslint-disable-next-line functional/prefer-readonly-type
    public Numberings: Numbering[] = [];
    // eslint-disable-next-line functional/prefer-readonly-type
    public Images: IImageRelationshipAddition[] = [];
    // eslint-disable-next-line functional/prefer-readonly-type
    public currentKey = "";

    public apply(): void {
        // TODO
    }
}

export type IDeepPatch = ParagraphPatch | FilePatch;
export type IPatch = IDeepPatch | TextPatch;

export interface PatchDocumentOptions {
    readonly patches: { readonly [key: string]: IPatch };
    readonly keepOriginalStyles?: boolean;
}

const imageReplacer = new ImageReplacer();

export const patchDocument = async (data: InputDataType, options: PatchDocumentOptions): Promise<Uint8Array> => {
    const zipContent = await JSZip.loadAsync(data);
    const contexts = new Map<string, IContext>();
    const file = {
        Media: new Media(),
    } as unknown as File;

    const map = new Map<string, Element>();
    // eslint-disable-next-line functional/prefer-readonly-type
    const textPatches: { [k: string]: TextPatch } = {};
    // eslint-disable-next-line functional/prefer-readonly-type
    const otherPatches: { [k: string]: ParagraphPatch | FilePatch } = {};

    for (const [key, value] of Object.entries(options.patches)) {
        if (value.type === PatchType.TEXT) {
            // eslint-disable-next-line functional/immutable-data
            textPatches[key] = value;
        } else {
            // eslint-disable-next-line functional/immutable-data
            otherPatches[key] = value;
        }
    }

    const wrapper = new PatchDocumentWrapper();

    const binaryContentMap = new Map<string, Uint8Array>();

    for (const [key, value] of Object.entries(zipContent.files)) {
        if (!key.endsWith(".xml") && !key.endsWith(".rels")) {
            binaryContentMap.set(key, await value.async("uint8array"));
            continue;
        }
        const text = await value.async("text");
        const json = toJson(applyTextPatches(text, textPatches));
        if (key.startsWith("word/") && !key.endsWith(".xml.rels")) {
            // eslint-disable-next-line functional/immutable-data
            wrapper.currentKey = key;
            const context: IContext = {
                file,
                viewWrapper: wrapper,
                stack: [],
            };
            contexts.set(key, context);

            for (const [patchKey, patchValue] of Object.entries(otherPatches)) {
                const patchText = `{{${patchKey}}}`;
                const renderedParagraphs = findLocationOfText(json, patchText);
                // TODO: mutates json. Make it immutable
                replacer(
                    json,
                    {
                        ...patchValue,
                        children: patchValue.children.map((element) => {
                            // We need to replace external hyperlinks with concrete hyperlinks
                            if (element instanceof ExternalHyperlink) {
                                const concreteHyperlink = new ConcreteHyperlink(element.options.children, uniqueId());
                                // eslint-disable-next-line functional/immutable-data
                                wrapper.Relationships.relationships.push({
                                    key,
                                    hyperlink: {
                                        id: concreteHyperlink.linkId,
                                        link: element.options.link,
                                    },
                                });
                                return concreteHyperlink;
                            } else {
                                return element;
                            }
                        }),
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } as any,
                    patchText,
                    renderedParagraphs,
                    context,
                    options.keepOriginalStyles,
                );
            }

            const mediaDatas = imageReplacer.getMediaData(JSON.stringify(json), context.file.Media);
            if (mediaDatas.length > 0) {
                // eslint-disable-next-line functional/immutable-data
                wrapper.Images.push({
                    key,
                    mediaDatas,
                });
            }
        }

        map.set(key, json);
    }

    for (const { key, mediaDatas } of wrapper.Images) {
        // eslint-disable-next-line functional/immutable-data
        const relationshipKey = `word/_rels/${key.split("/").pop()}.rels`;
        const relationshipsJson = map.get(relationshipKey) ?? createRelationshipFile();
        map.set(relationshipKey, relationshipsJson);

        const index = getNextRelationshipIndex(relationshipsJson);
        const newJson = imageReplacer.replace(JSON.stringify(map.get(key)), mediaDatas, index);
        map.set(key, JSON.parse(newJson) as Element);

        for (let i = 0; i < mediaDatas.length; i++) {
            const { fileName } = mediaDatas[i];
            appendRelationship(
                relationshipsJson,
                index + i,
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                `media/${fileName}`,
            );
        }
    }

    for (const { key, hyperlink } of wrapper.Relationships.relationships) {
        // eslint-disable-next-line functional/immutable-data
        const relationshipKey = `word/_rels/${key.split("/").pop()}.rels`;

        const relationshipsJson = map.get(relationshipKey) ?? createRelationshipFile();
        map.set(relationshipKey, relationshipsJson);

        appendRelationship(
            relationshipsJson,
            hyperlink.id,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            hyperlink.link,
            TargetModeType.EXTERNAL,
        );
    }

    for (const { abstractNumId, numId } of wrapper.Numberings) {
        const numberingJson = map.get("word/numbering.xml")!;
        map.set("word/numbering.xml", numberingJson);

        appendNumbering(numberingJson, abstractNumId, numId);
    }

    if (wrapper.Images.length > 0) {
        const contentTypesJson = map.get("[Content_Types].xml");

        if (!contentTypesJson) {
            throw new Error("Could not find content types file");
        }

        appendContentType(contentTypesJson, "image/png", "png");
        appendContentType(contentTypesJson, "image/jpeg", "jpeg");
        appendContentType(contentTypesJson, "image/jpeg", "jpg");
        appendContentType(contentTypesJson, "image/bmp", "bmp");
        appendContentType(contentTypesJson, "image/gif", "gif");
    }

    const zip = new JSZip();

    for (const [key, value] of map) {
        const output = toXml(value);

        zip.file(key, output);
    }

    for (const [key, value] of binaryContentMap) {
        zip.file(key, value);
    }

    for (const { stream, fileName } of file.Media.Array) {
        zip.file(`word/media/${fileName}`, stream);
    }

    return zip.generateAsync({
        type: "uint8array",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        compression: "DEFLATE",
    });
};

const toXml = (jsonObj: Element): string => {
    const output = js2xml(jsonObj);
    return output;
};

const createRelationshipFile = (): Element => ({
    declaration: {
        attributes: {
            version: "1.0",
            encoding: "UTF-8",
            standalone: "yes",
        },
    },
    elements: [
        {
            type: "element",
            name: "Relationships",
            attributes: {
                xmlns: "http://schemas.openxmlformats.org/package/2006/relationships",
            },
            elements: [],
        },
    ],
});
const applyTextPatches = (text: string, textPatches: { readonly [k: string]: TextPatch }): string => {
    let newText = text;

    for (const [key, patch] of Object.entries(textPatches)) {
        newText = newText.replace(new RegExp(`{{${key}}}`, "g"), patch.text);
    }

    return newText;
};
