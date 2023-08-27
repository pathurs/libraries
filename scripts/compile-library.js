import { LibraryCompiler } from './library-compiler.js';

const inputFilePath = process.argv[2];
const outputFilePath = process.argv[3];

if (inputFilePath == null || inputFilePath.length === 0) {
    throw new Error('Must provide a file path to read from.');
}

if (outputFilePath == null || outputFilePath.length === 0) {
    throw new Error('Must provide a file path to output to.');
}

const libraryCompiler = new LibraryCompiler(inputFilePath, outputFilePath);

libraryCompiler.compile();
