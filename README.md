# Clang-Tidy for VSCode

[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)

This extension integrates [clang-tidy](https://clang.llvm.org/extra/clang-tidy/) into VS Code.

[Clang-Tidy documentation can be found here.](https://clang.llvm.org/extra/clang-tidy/)

## Fork changes

- Fix work on big files, like 10k lines
- Fix quick-actions with insertions around original text
- Fix abort linting
- Disable cross-file quick-actions (it's require to open file in VSCode)
- Unpublish diagnostics, when overlapped code edited
- Save file after quick-actions (workaround for editing invalid position in followed quick-actions)
- Configurable progress bar location

## Features

Runs clang-tidy and displays its diagnostics in VS Code.

Note: Diagnostics take longer to appear than in the example gif.

![diagnostics example animation](images/diagnostics.gif)

## Requirements

Clang-Tidy must be installed. The extension will look for the clang-tidy executable in your `PATH` by default.

Clang-Tidy is part of LLVM, which can be [downloaded here.](https://releases.llvm.org/download.html) Alternatively, use your system's package manager.

## Extension Settings

This extension contributes the following settings:

-   `clang-tidy.executable`: The path to the clang-tidy executable
-   `clang-tidy.checks`: List of checks to enable or disable
-   `clang-tidy.compilerArgs`: List of arguments to append to the compiler command line
-   `clang-tidy.compilerArgsBefore`: List of arguments to prepend to the compiler command line
-   `clang-tidy.lintOnSave`: Whether or not to lint files when they are saved
-   `clang-tidy.buildPath`: Path to the build folder. Equivalent to clang-tidy -p /path
-   `clang-tidy.fixOnSave`: Whether or not to fix files when they are saved
-   `clang-tidy.blacklist`: A list of regular expressions matching files you don't want to lint

## Extension Commands

This extension contributes the following commands:

-   `Clang-Tidy: Lint File`: Lints the active file

## Known Issues

[See the Github issues](https://github.com/notskm/vscode-clang-tidy/issues)

## CS 128 Usage
Forked from [notskm/vscode-clang-tidy](https://github.com/notskm/vscode-clang-tidy) due to repository being archived and extension being taken off VS Code Marketplace.
