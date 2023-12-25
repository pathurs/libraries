import { compareBooleans, compareStringsBy } from '@colonise/utilities';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class LibraryCompiler {
    #glossaryEntryAdjacentCharacters = /[\s\,\.\!\-\(\)\'\"\“\”\’]/g;
    #glossaryEntryPreviousCharacters = new RegExp(`${this.#glossaryEntryAdjacentCharacters.source}|^`);
    #glossaryEntryNextCharacters = new RegExp(`${this.#glossaryEntryAdjacentCharacters.source}|$`);

    #glossary = {};
    #documents = [];

    constructor(inputFilePath, outputFilePath) {
        this.inputFilePath = inputFilePath;
        this.outputFilePath = outputFilePath;
    }

    async compile() {
        console.log('Reading...');

        this.libraryJSON = await this.#readJSONFileAndResolveFiles(this.inputFilePath);

        console.log('Parsing Glossary...');

        this.#glossary = this.#parseGlossary(this.libraryJSON.glossary);

        console.log('Parsing Documents...');

        this.#documents = this.#parseDocuments(this.libraryJSON.documents);

        console.log('Generating Glossary links...');

        this.#deepCompileGlossaryLinks();

        console.log('Writing to output...');

        await this.#generateOutput();

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

    #parseDocuments(rawDocuments) {
        const newDocuments = [...(rawDocuments ?? [])];

        return newDocuments;
    }

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

    #stringify(value) {
        return JSON.stringify(value, (key, value) => (value instanceof RegExp ? value.toString() : value), 4);
    }

    async #generateOutput() {
        await rm(this.outputFilePath, {
            recursive: true,
            force: true
        });

        await mkdir(this.outputFilePath, {
            recursive: true
        });

        await writeFile(
            `${this.outputFilePath}/library.json`,
            this.#stringify({
                title: this.libraryJSON.title,
                description: this.libraryJSON.description,
                reference: this.libraryJSON.reference
            })
        );

        await writeFile(
            `${this.outputFilePath}/glossary.json`,
            this.#stringify(
                this.#glossary.entries.reduce((accumulator, entry) => {
                    return {
                        ...accumulator,
                        [entry.id]: `./glossary/${entry.id}.json`
                    };
                }, {})
            )
        );

        await mkdir(`${this.outputFilePath}/glossary`);

        for (const entry of this.#glossary.entries) {
            await writeFile(
                `${this.outputFilePath}/glossary/${entry.id}.json`,
                this.#stringify({
                    id: entry.id,
                    title: entry.title,
                    aliases: entry.aliases,
                    regExp: entry.regExp
                })
            );
        }

        await writeFile(
            `${this.outputFilePath}/documents.json`,
            this.#stringify(
                this.#documents.reduce((accumulator, document) => {
                    return {
                        ...accumulator,
                        [document.id]: `./documents/${document.id}.json`
                    };
                }, {})
            )
        );

        await mkdir(`${this.outputFilePath}/documents`);

        for (const document of this.#documents) {
            await writeFile(`${this.outputFilePath}/documents/${document.id}.json`, this.#stringify(document));
        }
    }
}
