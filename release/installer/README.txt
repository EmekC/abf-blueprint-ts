abfc {version}
==============

abfc compiles TypeScript Blueprints for Abiotic Factor mods and publishes them
through the Mod Editor.

Files in this folder
--------------------
abfc.exe                    the command line tool; it carries its own Python and
                            the Mod Editor backend, nothing else has to be installed
abfc-vscode-*.vsix          the VS Code extension (diagnostics and commands)
LICENSE.txt                 the abfc license
THIRD-PARTY-NOTICES.txt     licenses of the bundled components
README.txt                  this file

The first command that needs the bundled runtime unpacks it once into
%LOCALAPPDATA%\abfc\runtime. "abfc doctor" shows where.

PATH
----
The installer can add this folder to your user PATH. Open a new terminal
afterwards so it sees the change. With the zip, either add the folder to PATH
yourself or run abfc.exe by its full path.

VS Code extension
-----------------
The installer offers to install it when VS Code is found. By hand:

    code --install-extension abfc-vscode-{version}.vsix

(use the exact file name of the .vsix in this folder).

Documentation
-------------
Install, updating and uninstalling:
https://github.com/EmekC/abf-blueprint-ts/blob/main/docs/install.md
Your first mod:
https://github.com/EmekC/abf-blueprint-ts/blob/main/docs/first-mod.md

Windows SmartScreen
-------------------
The downloads are not code-signed, so Windows may show "Windows protected your
PC". Choose "More info", then "Run anyway". To check a download first, compare
the output of

    Get-FileHash <file> -Algorithm SHA256

with the line for that file in SHA256SUMS.txt on the release page.

Uninstall
---------
Windows Settings > Apps > abfc. The uninstaller removes the program folder and
the PATH entry and asks before deleting the extracted runtime. Your projects,
mods and settings are never touched.
