import { compareBooleans, compareStringsBy } from '@colonise/utilities';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class LibraryCompiler {
    #glossaryEntryAdjacentCharacters = /[\s\,\.\!\-\(\)\'\"\“\”\’]/g;
    #glossaryEntryPreviousCharacters = new RegExp(`${this.#glossaryEntryAdjacentCharacters.source}|^`);
    #glossaryEntryNextCharacters = new RegExp(`${this.#glossaryEntryAdjacentCharacters.source}|$`);

    #glossary = {};
    #appendices = {};
    #documents = [];

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

    #createChildrenIdAndPathArray(parentId, children, extension, extras) {
        return children === undefined || children.length === 0
            ? undefined
            : children.map(child => {
                  return {
                      id: child.id,
                      path: `./${parentId}/${child.id}.${extension}`,
                      ...(extras?.(child) ?? {})
                  };
              });
    }

    #stringify(value) {
        return JSON.stringify(value, (key, value) => (value instanceof RegExp ? value.toString() : value), 4);
    }

    //#region Documents

    #parseDocuments(rawDocuments) {
        const newDocuments = [...(rawDocuments ?? [])];

        return newDocuments;
    }

    async #writeDocumentSectionOutput(section, parentPath, previousTotalFileCount = 0) {
        let totalFileCount = previousTotalFileCount;

        const sectionsFileCount = await this.#tryWriteDocumentSectionsOutput(
            section,
            parentPath,
            previousTotalFileCount
        );

        totalFileCount += sectionsFileCount;

        await writeFile(
            `${parentPath}/${section.id}.json`,
            this.#stringify({
                id: section.id,
                refereneId: section.referenceId,
                title: section.title,
                description: section.description,
                sections: this.#createChildrenIdAndPathArray(section.id, section.sections, 'json'),
                fileCount: sectionsFileCount
            })
        );

        totalFileCount += 1;

        return totalFileCount;
    }

    async #tryWriteDocumentSectionsOutput(idAndSections, parentPath, previousTotalFileCount = 0) {
        const { id, sections } = idAndSections;

        let totalFileCount = previousTotalFileCount;

        if (id !== undefined && sections !== undefined && sections.length > 0) {
            const sectionsPath = `${parentPath}/${id}`;

            await mkdir(sectionsPath, {
                recursive: true
            });

            for (const section of sections) {
                totalFileCount += await this.#writeDocumentSectionOutput(section, sectionsPath, previousTotalFileCount);
            }
        }

        return totalFileCount;
    }

    async #writeDocumentsOutput() {
        const directoryPath = `${this.outputFilePath}/documents`;
        const jsonPath = `${this.outputFilePath}/documents.json`;

        await mkdir(directoryPath, {
            recursive: true
        });

        let totalFileCount = 0;
        let documentFileCount = 0;
        let documentSectionFileCountDictionary = {};

        for (const document of this.#documents) {
            const sectionsFileCount = await this.#tryWriteDocumentSectionsOutput(document, directoryPath);

            totalFileCount += sectionsFileCount;

            await writeFile(
                `${directoryPath}/${document.id}.json`,
                this.#stringify({
                    id: document.id,
                    title: document.title,
                    description: document.description,
                    sections: this.#createChildrenIdAndPathArray(document.id, document.sections, 'json'),
                    fileCount: sectionsFileCount
                })
            );

            documentSectionFileCountDictionary[document.id] = sectionsFileCount;

            documentFileCount += 1;
        }

        totalFileCount += documentFileCount;

        await writeFile(
            jsonPath,
            this.#stringify({
                documents: this.#createChildrenIdAndPathArray('documents', this.#documents, 'json', document => {
                    return {
                        fileCount: documentSectionFileCountDictionary[document.id]
                    };
                }),
                fileCount: totalFileCount
            })
        );

        totalFileCount += 1;

        return {
            jsonPath: './documents.json',
            directoryPath: './documents',
            fileCount: totalFileCount
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

        let totalFileCount = 0;

        await writeFile(
            jsonPath,
            this.#stringify(this.#appendices) // TODO
        );

        totalFileCount += 1;

        return {
            jsonPath: './appendices.json',
            directoryPath: './appendices',
            fileCount: totalFileCount
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
            entries: [...(rawGlossary.entries ?? [])]
        };

        for (const entry of newGlossary.entries) {
            entry.regExp = this.#createRegExpForGlossaryEntry(entry);

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

        return newGlossary;
    }

    async #writeGlossaryOutput() {
        const directoryPath = `${this.outputFilePath}/glossary`;
        const jsonPath = `${this.outputFilePath}/glossary.json`;

        await mkdir(directoryPath, {
            recursive: true
        });

        let totalFileCount = 0;
        let entryFileCount = 0;

        for (const entry of this.#glossary.entries) {
            await writeFile(
                `${directoryPath}/${entry.id}.json`,
                this.#stringify({
                    id: entry.id,
                    title: entry.title,
                    aliases: entry.aliases,
                    regExp: entry.regExp
                })
            );

            entryFileCount += 1;
        }

        totalFileCount += entryFileCount;

        await writeFile(
            jsonPath,
            this.#stringify({
                entries: this.#createChildrenIdAndPathArray('glossary', this.#glossary.entries, 'json', entry => {
                    return {
                        title: entry.title
                    };
                }),
                fileCount: totalFileCount
            })
        );

        totalFileCount += 1;

        return {
            jsonPath: './glossary.json',
            directoryPath: './glossary',
            fileCount: totalFileCount
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
        if (this.#glossary.entries.length === 0 || this.#documents.length === 0) {
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

        for (const document of this.#documents) {
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
                fileCount: documentsDetails.fileCount + appendicesDetails.fileCount + glossaryDetails.fileCount
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
