import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class LibraryCompiler {
    #glossaryEntryAdjacentCharacters = /[\s\,\.\!\-\(\)\'\"\“\”\’]/g;
    #glossaryEntryPreviousCharacters = new RegExp(`${this.#glossaryEntryAdjacentCharacters.source}|^`);
    #glossaryEntryNextCharacters = new RegExp(`${this.#glossaryEntryAdjacentCharacters.source}|$`);

    constructor(inputFilePath, outputFilePath) {
        this.inputFilePath = inputFilePath;
        this.outputFilePath = outputFilePath;
    }

    async compile() {
        console.log('Reading...');

        this.libraryJSON = await this.#readJSONFileAndResolveFiles(this.inputFilePath);

        console.log('Generating glossary links...');

        this.#deepCompileGlossaryLinks();

        console.log('Writing to output...');

        await writeFile(this.outputFilePath, JSON.stringify(this.libraryJSON, undefined, 4));

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

        if (this.libraryJSON.glossary?.entries == null || this.libraryJSON.glossary?.entries.length === 0) {
            return;
        }

        let result = text;

        for (const glossaryEntry of this.libraryJSON.glossary.entries) {
            result = result.replaceAll(
                this.#createRegExpForGlossaryEntry(glossaryEntry),
                (...match) => `${match[1]}$${match[2]}:${glossaryEntry.id}$${match[3] ?? ''}`
            );
        }

        return result;
    }

    #deepCompileGlossaryLinks() {
        if (
            this.libraryJSON.glossary?.entries == null ||
            this.libraryJSON.glossary?.entries.length === 0 ||
            this.libraryJSON.documents == null ||
            this.libraryJSON.documents.length === 0
        ) {
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

        for (const document of this.libraryJSON.documents) {
            mutate(document, 'description');

            if (this.libraryJSON.documents == null || this.libraryJSON.documents.length === 0) {
                return;
            }

            mutateSections(document.sections);
        }

        for (const glossaryEntry of this.libraryJSON.glossary.entries) {
            mutate(glossaryEntry, 'description');
        }
    }
}
