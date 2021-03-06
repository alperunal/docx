import * as JSZip from "jszip";
import { Element as XMLElement, ElementCompact as XMLElementCompact, xml2js } from "xml-js";

import { FooterReferenceType } from "file/document/body/section-properties/footer-reference";
import { HeaderReferenceType } from "file/document/body/section-properties/header-reference";
import { FooterWrapper, IDocumentFooter } from "file/footer-wrapper";
import { HeaderWrapper, IDocumentHeader } from "file/header-wrapper";
import { Media } from "file/media";
import { TargetModeType } from "file/relationships/relationship/relationship";
import { Styles } from "file/styles";
import { ExternalStylesFactory } from "file/styles/external-styles-factory";
import { convertToXmlComponent, ImportedXmlComponent } from "file/xml-components";

const schemeToType = {
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header": "header",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer": "footer",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image": "image",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink": "hyperlink",
};

interface IDocumentRefs {
    readonly headers: Array<{ readonly id: number; readonly type: HeaderReferenceType }>;
    readonly footers: Array<{ readonly id: number; readonly type: FooterReferenceType }>;
}

enum RelationshipType {
    HEADER = "header",
    FOOTER = "footer",
    IMAGE = "image",
    HYPERLINK = "hyperlink",
}

interface IRelationshipFileInfo {
    readonly id: number;
    readonly target: string;
    readonly type: RelationshipType;
}

// Document Template
// https://fileinfo.com/extension/dotx
export interface IDocumentTemplate {
    readonly currentRelationshipId: number;
    readonly headers: IDocumentHeader[];
    readonly footers: IDocumentFooter[];
    readonly styles: Styles;
    readonly titlePageIsDefined: boolean;
}

export class ImportDotx {
    // tslint:disable-next-line:readonly-keyword
    private currentRelationshipId: number;

    constructor() {
        this.currentRelationshipId = 1;
    }

    public async extract(data: Buffer): Promise<IDocumentTemplate> {
        const zipContent = await JSZip.loadAsync(data);

        const stylesContent = await zipContent.files["word/styles.xml"].async("text");
        const documentContent = await zipContent.files["word/document.xml"].async("text");
        const relationshipContent = await zipContent.files["word/_rels/document.xml.rels"].async("text");

        const stylesFactory = new ExternalStylesFactory();
        const documentRefs = this.extractDocumentRefs(documentContent);
        const documentRelationships = this.findReferenceFiles(relationshipContent);

        const media = new Media();

        const templateDocument: IDocumentTemplate = {
            headers: await this.createHeaders(zipContent, documentRefs, documentRelationships, media),
            footers: await this.createFooters(zipContent, documentRefs, documentRelationships, media),
            currentRelationshipId: this.currentRelationshipId,
            styles: stylesFactory.newInstance(stylesContent),
            titlePageIsDefined: this.checkIfTitlePageIsDefined(documentContent),
        };

        return templateDocument;
    }

    private async createFooters(
        zipContent: JSZip,
        documentRefs: IDocumentRefs,
        documentRelationships: IRelationshipFileInfo[],
        media: Media,
    ): Promise<IDocumentFooter[]> {
        const footers: IDocumentFooter[] = [];

        for (const footerRef of documentRefs.footers) {
            const relationFileInfo = documentRelationships.find((rel) => rel.id === footerRef.id);

            if (relationFileInfo === null || !relationFileInfo) {
                throw new Error(`Can not find target file for id ${footerRef.id}`);
            }

            const xmlData = await zipContent.files[`word/${relationFileInfo.target}`].async("text");
            const xmlObj = xml2js(xmlData, { compact: false, captureSpacesBetweenElements: true }) as XMLElement;
            let footerXmlElement: XMLElement | undefined;
            for (const xmlElm of xmlObj.elements || []) {
                if (xmlElm.name === "w:ftr") {
                    footerXmlElement = xmlElm;
                }
            }
            if (footerXmlElement === undefined) {
                continue;
            }
            const importedComp = convertToXmlComponent(footerXmlElement) as ImportedXmlComponent;
            const footer = new FooterWrapper(media, this.currentRelationshipId++, importedComp);
            await this.addRelationshipToWrapper(relationFileInfo, zipContent, footer, media);
            footers.push({ type: footerRef.type, footer });
        }

        return footers;
    }

    private async createHeaders(
        zipContent: JSZip,
        documentRefs: IDocumentRefs,
        documentRelationships: IRelationshipFileInfo[],
        media: Media,
    ): Promise<IDocumentHeader[]> {
        const headers: IDocumentHeader[] = [];

        for (const headerRef of documentRefs.headers) {
            const relationFileInfo = documentRelationships.find((rel) => rel.id === headerRef.id);
            if (relationFileInfo === null || !relationFileInfo) {
                throw new Error(`Can not find target file for id ${headerRef.id}`);
            }

            const xmlData = await zipContent.files[`word/${relationFileInfo.target}`].async("text");
            const xmlObj = xml2js(xmlData, { compact: false, captureSpacesBetweenElements: true }) as XMLElement;
            let headerXmlElement: XMLElement | undefined;
            for (const xmlElm of xmlObj.elements || []) {
                if (xmlElm.name === "w:hdr") {
                    headerXmlElement = xmlElm;
                }
            }
            if (headerXmlElement === undefined) {
                continue;
            }
            const importedComp = convertToXmlComponent(headerXmlElement) as ImportedXmlComponent;
            const header = new HeaderWrapper(media, this.currentRelationshipId++, importedComp);
            // await this.addMedia(zipContent, media, documentRefs, documentRelationships);
            await this.addRelationshipToWrapper(relationFileInfo, zipContent, header, media);
            headers.push({ type: headerRef.type, header });
        }

        return headers;
    }

    private async addRelationshipToWrapper(
        relationhipFile: IRelationshipFileInfo,
        zipContent: JSZip,
        wrapper: HeaderWrapper | FooterWrapper,
        media: Media,
    ): Promise<void> {
        const refFile = zipContent.files[`word/_rels/${relationhipFile.target}.rels`];

        if (!refFile) {
            return;
        }

        const xmlRef = await refFile.async("text");
        const wrapperImagesReferences = this.findReferenceFiles(xmlRef).filter((r) => r.type === RelationshipType.IMAGE);
        const hyperLinkReferences = this.findReferenceFiles(xmlRef).filter((r) => r.type === RelationshipType.HYPERLINK);

        for (const r of wrapperImagesReferences) {
            const buffer = await zipContent.files[`word/${r.target}`].async("nodebuffer");
            const mediaData = media.addMedia(buffer);

            wrapper.Relationships.createRelationship(
                r.id,
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                `media/${mediaData.fileName}`,
            );
        }

        for (const r of hyperLinkReferences) {
            wrapper.Relationships.createRelationship(
                r.id,
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                r.target,
                TargetModeType.EXTERNAL,
            );
        }
    }

    private findReferenceFiles(xmlData: string): IRelationshipFileInfo[] {
        const xmlObj = xml2js(xmlData, { compact: true }) as XMLElementCompact;
        const relationXmlArray = Array.isArray(xmlObj.Relationships.Relationship)
            ? xmlObj.Relationships.Relationship
            : [xmlObj.Relationships.Relationship];
        const relationships: IRelationshipFileInfo[] = relationXmlArray
            .map((item: XMLElementCompact) => {
                if (item._attributes === undefined) {
                    throw Error("relationship element has no attributes");
                }
                return {
                    id: this.parseRefId(item._attributes.Id as string),
                    type: schemeToType[item._attributes.Type as string],
                    target: item._attributes.Target as string,
                };
            })
            .filter((item) => item.type !== null);
        return relationships;
    }

    private extractDocumentRefs(xmlData: string): IDocumentRefs {
        const xmlObj = xml2js(xmlData, { compact: true }) as XMLElementCompact;
        const sectionProp = xmlObj["w:document"]["w:body"]["w:sectPr"];

        const headerProps: XMLElementCompact = sectionProp["w:headerReference"];
        let headersXmlArray: XMLElementCompact[];
        if (headerProps === undefined) {
            headersXmlArray = [];
        } else if (Array.isArray(headerProps)) {
            headersXmlArray = headerProps;
        } else {
            headersXmlArray = [headerProps];
        }
        const headers = headersXmlArray.map((item) => {
            if (item._attributes === undefined) {
                throw Error("header referecne element has no attributes");
            }
            return {
                type: item._attributes["w:type"] as HeaderReferenceType,
                id: this.parseRefId(item._attributes["r:id"] as string),
            };
        });

        const footerProps: XMLElementCompact = sectionProp["w:footerReference"];
        let footersXmlArray: XMLElementCompact[];
        if (footerProps === undefined) {
            footersXmlArray = [];
        } else if (Array.isArray(footerProps)) {
            footersXmlArray = footerProps;
        } else {
            footersXmlArray = [footerProps];
        }

        const footers = footersXmlArray.map((item) => {
            if (item._attributes === undefined) {
                throw Error("footer referecne element has no attributes");
            }
            return {
                type: item._attributes["w:type"] as FooterReferenceType,
                id: this.parseRefId(item._attributes["r:id"] as string),
            };
        });

        return { headers, footers };
    }

    private checkIfTitlePageIsDefined(xmlData: string): boolean {
        const xmlObj = xml2js(xmlData, { compact: true }) as XMLElementCompact;
        const sectionProp = xmlObj["w:document"]["w:body"]["w:sectPr"];

        return sectionProp["w:titlePg"] !== undefined;
    }

    private parseRefId(str: string): number {
        const match = /^rId(\d+)$/.exec(str);
        if (match === null) {
            throw new Error("Invalid ref id");
        }
        return parseInt(match[1], 10);
    }
}
