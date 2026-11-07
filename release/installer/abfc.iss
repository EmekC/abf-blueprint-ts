; abfc installer (Inno Setup 6.3 or newer). Built by scripts/release/build-installer.mjs, which passes these defines:
;   AppVersion  release version, e.g. 1.0.0-rc.0
;   InputDir    folder with the staged files (abfc.exe, the .vsix, LICENSE.txt, THIRD-PARTY-NOTICES.txt, README.txt)
;   OutputDir   folder for abfc-setup-<version>.exe
;   VsixName    file name of the VS Code extension inside InputDir
;   LicenseFile full path of LICENSE.txt
; Installs per user (no admin) into %LOCALAPPDATA%\Programs\abfc. Never touches %APPDATA%\abfc (user config), projects or mods.

#ifndef AppVersion
  #error AppVersion is not defined (pass /DAppVersion=<version>)
#endif
#ifndef InputDir
  #error InputDir is not defined (pass /DInputDir=<folder>)
#endif
#ifndef OutputDir
  #error OutputDir is not defined (pass /DOutputDir=<folder>)
#endif
#ifndef VsixName
  #error VsixName is not defined (pass /DVsixName=<file name>)
#endif
#ifndef LicenseFile
  #error LicenseFile is not defined (pass /DLicenseFile=<file>)
#endif

[Setup]
AppId={{8F3C2A71-5D4E-4B6A-9E1F-2C7D0B9A4E53}
AppName=abfc
AppVersion={#AppVersion}
AppVerName=abfc {#AppVersion}
AppPublisher=abfc contributors
AppPublisherURL=https://github.com/EmekC/abf-blueprint-ts
DefaultDirName={userpf}\abfc
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes
OutputDir={#OutputDir}
OutputBaseFilename=abfc-setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=classic
LicenseFile={#LicenseFile}
UninstallDisplayIcon={app}\abfc.exe
UninstallDisplayName=abfc {#AppVersion}
SetupLogging=yes

[Tasks]
Name: "addtopath"; Description: "Add abfc to PATH"
Name: "vsix"; Description: "Install the abfc extension into VS Code"; Check: VsCodeFound

[Files]
Source: "{#InputDir}\*"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "{cmd}"; Parameters: "/d /c """"{code:CodeCmd}"" --install-extension ""{app}\{#VsixName}"" --force"""; Tasks: vsix; Flags: runhidden waituntilterminated; StatusMsg: "Installing the VS Code extension..."

[Code]
const
  EnvironmentKey = 'Environment';

// First existing code.cmd: per-user install, system install, then PATH. '' when VS Code is not found.
function CodeCmd(Param: String): String;
var
  P: String;
begin
  Result := '';
  P := ExpandConstant('{localappdata}\Programs\Microsoft VS Code\bin\code.cmd');
  if FileExists(P) then
  begin
    Result := P;
    Exit;
  end;
  P := ExpandConstant('{commonpf64}\Microsoft VS Code\bin\code.cmd');
  if FileExists(P) then
  begin
    Result := P;
    Exit;
  end;
  Result := FileSearch('code.cmd', GetEnv('PATH'));
end;

function VsCodeFound(): Boolean;
begin
  Result := CodeCmd('') <> '';
end;

// Lower case, without trailing backslashes: the form in which PATH entries are compared.
function NormalizeDir(const S: String): String;
begin
  Result := Lowercase(Trim(S));
  while (Length(Result) > 0) and (Result[Length(Result)] = '\') do
    Delete(Result, Length(Result), 1);
end;

function PathHasDir(const Paths, Dir: String): Boolean;
var
  Rest, Item, Wanted: String;
  P: Integer;
begin
  Result := False;
  Wanted := NormalizeDir(Dir);
  Rest := Paths;
  while Rest <> '' do
  begin
    P := Pos(';', Rest);
    if P = 0 then
    begin
      Item := Rest;
      Rest := '';
    end else
    begin
      Item := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, Length(Rest));
    end;
    if (Item <> '') and (NormalizeDir(Item) = Wanted) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

procedure AddToPath(Dir: String);
var
  Paths: String;
begin
  if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Paths) then
    Paths := '';
  if PathHasDir(Paths, Dir) then
    Exit;
  if Paths = '' then
    Paths := Dir
  else if Paths[Length(Paths)] = ';' then
    Paths := Paths + Dir
  else
    Paths := Paths + ';' + Dir;
  RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path', Paths);
end;

// Rebuilds PATH without the entries equal to Dir (case-insensitive, with or without a trailing backslash); order and other entries stay.
procedure RemoveFromPath(Dir: String);
var
  Paths, Rest, Item, Wanted, Output: String;
  P: Integer;
  Changed: Boolean;
begin
  if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Paths) then
    Exit;
  Wanted := NormalizeDir(Dir);
  Rest := Paths;
  Output := '';
  Changed := False;
  while Rest <> '' do
  begin
    P := Pos(';', Rest);
    if P = 0 then
    begin
      Item := Rest;
      Rest := '';
    end else
    begin
      Item := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, Length(Rest));
    end;
    if (Item <> '') and (NormalizeDir(Item) = Wanted) then
      Changed := True
    else if Item <> '' then
    begin
      if Output = '' then
        Output := Item
      else
        Output := Output + ';' + Item;
    end;
  end;
  if Changed then
    RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path', Output);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addtopath') then
    AddToPath(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  R: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RemoveFromPath(ExpandConstant('{app}'));
    R := ExpandConstant('{localappdata}\abfc\runtime');
    if DirExists(R) then
    begin
      if SuppressibleMsgBox('Also delete the extracted abfc runtime in ' + R + '? Your projects, mods and settings are not touched.',
        mbConfirmation, MB_YESNO, IDNO) = IDYES then
        DelTree(R, True, True, True);
    end;
  end;
end;
