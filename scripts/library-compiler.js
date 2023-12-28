import { compareBooleans, compareStringsBy } from '@colonise/utilities';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class LibraryCompiler {
    #glossaryEntryAdjacentCharacters = /[\s\,\.\!\-\(\)\'\"\“\”\’]/g;
    #glossaryEntryPreviousCharacters = new RegExp(`${this.#glossaryEntryAdjacentCharacters.source}|^`);
    #glossaryEntryNextCharacters = new RegExp(`${this.#glossaryEntryAdjacentCharacters.source}|$`);

    #glossary = {};
    #appendices = {};
    #documents = {};

    constructor(inputFilePath, outputFilePath) {
        this.inputFilePath = inputFilePath;
        this.outputFilePath = outputFilePath;
    }

    async compile() {
        console.log('Reading...');

        this.libraryJSON = await this.#readJSONFileAndResolveFiles(this.inputFilePath);

        console.log('Parsing Documents...');

        this.#documents = this.#parseDocuments(this.libraryJSON.documents);

        console.log('Parsing Appendices...');

        this.#glossary = this.#parseAppendices(this.libraryJSON.appendices);

        console.log('Parsing Glossary...');

        this.#glossary = this.#parseGlossary(this.libraryJSON.glossary);

        console.log('Generating Glossary links...');

        this.#deepCompileGlossaryLinks();

        console.log('Writing to output...');

        await this.#writeOutput();

        console.log('Done!');
    }

    async #readJSONFile(filePath) {
        const fileBuffer = await readFile(filePath);
        const fileString = fileBuffer.toString();
        const fileJSON = fileString.trim().length === 0 ? undefined : JSON.parse(fileString);

        return fileJSON;
    }

    async #readMarkdownFile(filePath) {
        const fileBuffer = await readFile(filePath);
        const fileString = fileBuffer.toString();

        return fileString;
    }

    #extractFilePath(text) {
        return text.replace(/^[a-zA-Z]+\:/, '');
    }

    #resolveRelativeFilePath(currentFilePath, filePath) {
        return join(dirname(currentFilePath), filePath);
    }

    async #resolveFiles(object, filePath) {
        if (object == null) {
            return undefined;
        }

        let result = Array.isArray(object)
            ? [...object]
            : {
                  ...object
              };

        for (const propertyKey of Object.keys(result)) {
            const propertyValue = result[propertyKey];

            switch (typeof propertyValue) {
                case 'string': {
                    if (propertyValue.startsWith('json:')) {
                        result[propertyKey] = await this.#resolveFiles(
                            await this.#readJSONFileAndResolveFiles(
                                this.#resolveRelativeFilePath(filePath, this.#extractFilePath(propertyValue))
                            ),
                            filePath
                        );
                    }

                    if (propertyValue.startsWith('markdown:')) {
                        result[propertyKey] = await this.#readMarkdownFile(
                            this.#resolveRelativeFilePath(filePath, this.#extractFilePath(propertyValue))
                        );
                    }

                    break;
                }

                case 'object': {
                    result[propertyKey] = await this.#resolveFiles(result[propertyKey], filePath);

                    break;
                }
            }
        }

        return result;
    }

    async #readJSONFileAndResolveFiles(filePath) {
        const fileJSON = await this.#readJSONFile(filePath);

        return await this.#resolveFiles(fileJSON, filePath);
    }

    #createChildrenIdAndJSONPathArray(parentId, children, extension, extras) {
        return children === undefined || children.length === 0
            ? undefined
            : children.map(child => {
                  return {
                      id: child.id,
                      jsonPath: `./${parentId}/${child.id}.${extension}`,
                      title: child.title,
                      descendantCount: child.descendantCount,
                      ...(extras?.(child) ?? {})
                  };
              });
    }

    #stringify(value) {
        return JSON.stringify(value, (key, value) => (value instanceof RegExp ? value.toString() : value), 4);
    }

    //#region Documents

    #parseSections(rawSections) {
        const newSections = [];

        for (const rawSection of rawSections) {
            const newSection = {
                ...rawSection,
                sections: this.#parseSections(rawSection.sections ?? [])
            };

            newSection.descendantCount =
                newSection.sections.length +
                newSection.sections.reduce((accumulator, section) => accumulator + section.descendantCount, 0);

            newSections.push(newSection);
        }

        return newSections;
    }

    #parseDocuments(rawDocuments) {
        const newDocuments = {
            id: 'documents',
            title: 'Documents',
            documents: []
        };

        for (const rawDocument of rawDocuments) {
            const newDocument = {
                ...rawDocument,
                sections: this.#parseSections(rawDocument.sections ?? [])
            };

            newDocument.descendantCount =
                newDocument.sections.length +
                newDocument.sections.reduce((accumulator, section) => accumulator + section.descendantCount, 0);

            newDocuments.documents.push(newDocument);
        }

        newDocuments.descendantCount =
            newDocuments.documents.length +
            newDocuments.documents.reduce((accumulator, document) => accumulator + document.descendantCount, 0);

        return newDocuments;
    }

    async #writeDocumentSectionOutput(section, parentPath) {
        await this.#tryWriteDocumentSectionsOutput(section, parentPath);

        await writeFile(
            `${parentPath}/${section.id}.json`,
            this.#stringify({
                id: section.id,
                refereneId: section.referenceId,
                title: section.title,
                description: section.description,
                sections: this.#createChildrenIdAndJSONPathArray(section.id, section.sections, 'json'),
                descendantCount: section.descendantCount
            })
        );
    }

    async #tryWriteDocumentSectionsOutput(idAndSections, parentPath) {
        const { id, sections } = idAndSections;

        if (id !== undefined && sections !== undefined && sections.length > 0) {
            const sectionsPath = `${parentPath}/${id}`;

            await mkdir(sectionsPath, {
                recursive: true
            });

            for (const section of sections) {
                await this.#writeDocumentSectionOutput(section, sectionsPath);
            }
        }
    }

    async #writeDocumentsOutput() {
        const directoryPath = `${this.outputFilePath}/documents`;
        const jsonPath = `${this.outputFilePath}/documents.json`;

        await mkdir(directoryPath, {
            recursive: true
        });

        for (const document of this.#documents.documents) {
            await this.#tryWriteDocumentSectionsOutput(document, directoryPath);

            await writeFile(
                `${directoryPath}/${document.id}.json`,
                this.#stringify({
                    id: document.id,
                    title: document.title,
                    description: document.description,
                    sections: this.#createChildrenIdAndJSONPathArray(document.id, document.sections, 'json'),
                    descendantCount: document.descendantCount
                })
            );
        }

        await writeFile(
            jsonPath,
            this.#stringify({
                id: this.#documents.id,
                title: this.#documents.title,
                documents: this.#createChildrenIdAndJSONPathArray('documents', this.#documents.documents, 'json'),
                descendantCount: this.#documents.descendantCount
            })
        );

        return {
            id: this.#documents.id,
            jsonPath: './documents.json',
            title: this.#documents.title,
            descendantCount: this.#documents.descendantCount
        };
    }

    //#endregion

    //#region Appendices

    #parseAppendices(rawAppendices) {
        const newAppendices = { ...(rawAppendices ?? {}) };

        return newAppendices;
    }

    async #writeAppendicesOutput() {
        const directoryPath = `${this.outputFilePath}/appendices`;
        const jsonPath = `${this.outputFilePath}/appendices.json`;

        await mkdir(directoryPath, {
            recursive: true
        });

        await writeFile(
            jsonPath,
            this.#stringify(this.#appendices) // TODO
        );

        return {
            id: this.#appendices.id,
            jsonPath: './appendices.json',
            title: this.#appendices.title ?? 'Appendices',
            descendantCount: 0
        };
    }

    //#endregion

    //#region Glossary

    #createRegExpForGlossaryEntry(glossaryEntry) {
        const escape = text => text.replace(/[\\\^\$\.\*\+\?\(\)\[\]\{\}\|]/g, (...match) => `\\${match[1]}`);

        return RegExp(
            `(${this.#glossaryEntryPreviousCharacters.source})(${[
                escape(glossaryEntry.title),
                ...(glossaryEntry.aliases?.map(alias => escape(alias)) ?? [])
            ].join('|')})(${this.#glossaryEntryNextCharacters.source})`,
            'gi'
        );
    }

    #parseGlossary(rawGlossary) {
        const newGlossary = {
            id: rawGlossary.id ?? 'glossary',
            title: rawGlossary.title ?? 'Glossary',
            entries: []
        };

        for (const rawEntry of rawGlossary.entries) {
            const entry = {
                ...rawEntry,
                descendantCount: 0
            };

            entry.regExp = this.#createRegExpForGlossaryEntry(entry);

            newGlossary.entries.push(entry);
        }

        for (const entry of newGlossary.entries) {
            for (const otherEntry of newGlossary.entries) {
                if (entry === otherEntry) {
                    continue;
                }

                const hasConflict = [otherEntry.id, ...(otherEntry.aliases ?? [])].some(idOrAlias =>
                    entry.regExp.test(idOrAlias)
                );

                if (hasConflict) {
                    otherEntry.conflicts ??= [];
                    otherEntry.conflicts.push(entry.id);
                }
            }
        }

        newGlossary.entries.sort(compareStringsBy(entry => entry.id));

        newGlossary.entries.sort((entryA, entryB) => compareBooleans(entryA.conflicts?.includes(entryB.id)));

        newGlossary.descendantCount = newGlossary.entries.length;

        return newGlossary;
    }

    async #writeGlossaryOutput() {
        const directoryPath = `${this.outputFilePath}/glossary`;
        const jsonPath = `${this.outputFilePath}/glossary.json`;

        await mkdir(directoryPath, {
            recursive: true
        });

        for (const entry of this.#glossary.entries) {
            await writeFile(
                `${directoryPath}/${entry.id}.json`,
                this.#stringify({
                    id: entry.id,
                    title: entry.title,
                    description: entry.description,
                    aliases: entry.aliases,
                    reference: entry.reference,
                    regExp: entry.regExp
                })
            );
        }

        await writeFile(
            jsonPath,
            this.#stringify({
                id: this.#glossary.id,
                title: this.#glossary.title,
                entries: this.#createChildrenIdAndJSONPathArray('glossary', this.#glossary.entries, 'json'),
                descendantCount: this.#glossary.descendantCount
            })
        );

        return {
            id: this.#glossary.id,
            jsonPath: './glossary.json',
            title: this.#glossary.title,
            descendantCount: this.#glossary.descendantCount
        };
    }

    #compileGlossaryLinks(text) {
        if (text == null) {
            return undefined;
        }

        if (this.#glossary.entries.length === 0) {
            return;
        }

        let result = text;

        for (const glossaryEntry of this.#glossary.entries) {
            result = result.replaceAll(
                glossaryEntry.regExp,
                (...match) => `${match[1]}$${match[2]}:${glossaryEntry.id}$${match[3] ?? ''}`
            );
        }

        return result;
    }

    #deepCompileGlossaryLinks() {
        if (this.#glossary.entries.length === 0 || this.#documents.documents.length === 0) {
            return;
        }

        const mutate = (object, property) => {
            if (typeof object === 'object' && object != null && typeof object[property] === 'string') {
                object[property] = this.#compileGlossaryLinks(object[property]);
            }
        };

        const mutateSections = sections => {
            if (!Array.isArray(sections)) {
                return;
            }

            for (const section of sections) {
                mutate(section, 'description');

                mutateSections(section.sections);
            }
        };

        mutate(this.libraryJSON, 'description');

        for (const document of this.#documents.documents) {
            mutate(document, 'description');

            if (document.sections == null || document.sections.length === 0) {
                return;
            }

            mutateSections(document.sections);
        }

        for (const glossaryEntry of this.#glossary.entries) {
            mutate(glossaryEntry, 'description');
        }
    }

    //#endregion

    async #writeLibraryOutput(documentsDetails, appendicesDetails, glossaryDetails) {
        await writeFile(
            `${this.outputFilePath}/library.json`,
            this.#stringify({
                title: this.libraryJSON.title,
                description: this.libraryJSON.description,
                reference: this.libraryJSON.reference,
                documents: documentsDetails,
                appendices: appendicesDetails,
                glossary: glossaryDetails,
                descendantCount:
                    documentsDetails.descendantCount +
                    1 +
                    appendicesDetails.descendantCount +
                    1 +
                    glossaryDetails.descendantCount +
                    1
            })
        );
    }

    async #writeOutput() {
        await rm(this.outputFilePath, {
            recursive: true,
            force: true
        });

        await mkdir(`${this.outputFilePath}`, {
            recursive: true
        });

        const documentsDetails = await this.#writeDocumentsOutput();
        const appendicesDetails = await this.#writeAppendicesOutput();
        const glossaryDetails = await this.#writeGlossaryOutput();

        await this.#writeLibraryOutput(documentsDetails, appendicesDetails, glossaryDetails);
    }
}
