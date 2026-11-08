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

var
  ProcPid, ProcParent: array of Integer;
  ProcName, ProcPath: array of String;

// Lower case with backslashes: the form in which paths are compared.
function PathKey(const S: String): String;
begin
  Result := Lowercase(Trim(S));
  StringChangeEx(Result, '/', '\', True);
end;

function VarText(const V: Variant): String;
begin
  if VarIsNull(V) or VarIsEmpty(V) then
    Result := ''
  else
    Result := V;
end;

// Reads the running processes through WMI into ProcPid / ProcParent / ProcName / ProcPath. Raises when WMI is not usable.
procedure LoadProcesses();
var
  Locator, Service, Items, Item, V: Variant;
  I, N: Integer;
begin
  Locator := CreateOleObject('WbemScripting.SWbemLocator');
  Service := Locator.ConnectServer('.', 'root\CIMV2');
  // 16 = wbemFlagReturnImmediately, without forward-only so that Count and ItemIndex work.
  Items := Service.ExecQuery('SELECT ProcessId, ParentProcessId, Name, ExecutablePath FROM Win32_Process', 'WQL', 16);
  N := Items.Count;
  SetArrayLength(ProcPid, N);
  SetArrayLength(ProcParent, N);
  SetArrayLength(ProcName, N);
  SetArrayLength(ProcPath, N);
  for I := 0 to N - 1 do
  begin
    ProcPid[I] := -1;
    ProcParent[I] := -1;
    ProcName[I] := '';
    ProcPath[I] := '';
    try
      Item := Items.ItemIndex(I);
      V := Item.ProcessId;
      ProcPid[I] := StrToIntDef(VarText(V), -1);
      V := Item.ParentProcessId;
      ProcParent[I] := StrToIntDef(VarText(V), -1);
      V := Item.Name;
      ProcName[I] := VarText(V);
      V := Item.ExecutablePath;
      ProcPath[I] := VarText(V);
    except
      // The process ended while it was being read: it stays an empty entry.
    end;
  end;
end;

function IndexOfPid(Pid: Integer): Integer;
var
  I: Integer;
begin
  Result := -1;
  if Pid < 0 then
    Exit;
  for I := 0 to GetArrayLength(ProcPid) - 1 do
    if ProcPid[I] = Pid then
    begin
      Result := I;
      Exit;
    end;
end;

// True when process I runs a file inside the install folder (AppPrefix: PathKey of the folder, with a trailing backslash).
// Setup / the uninstaller itself is never counted.
function IsInsideApp(I: Integer; const AppPrefix: String): Boolean;
var
  Key: String;
begin
  Result := False;
  if ProcPath[I] = '' then
    Exit;
  Key := PathKey(ProcPath[I]);
  if Copy(Key, 1, Length(AppPrefix)) <> AppPrefix then
    Exit;
  if Copy(Lowercase(ProcName[I]), 1, 5) = 'unins' then
    Exit;
  // {srcexe} cannot be evaluated while uninstalling; the running unins*.exe is skipped by name above.
  if not IsUninstaller then
    if Key = PathKey(ExpandConstant('{srcexe}')) then
      Exit;
  Result := True;
end;

// 1 editor, 2 terminal, 3 other program, 0 none (explorer.exe, nothing). Friendly gets the name to show.
function OwnerKind(const ExeName: String; var Friendly: String): Integer;
var
  E: String;
begin
  E := Lowercase(ExeName);
  Friendly := '';
  Result := 1;
  if E = 'code.exe' then
    Friendly := 'Visual Studio Code'
  else if E = 'code - insiders.exe' then
    Friendly := 'Visual Studio Code Insiders'
  else if E = 'vscodium.exe' then
    Friendly := 'VSCodium'
  else if E = 'cursor.exe' then
    Friendly := 'Cursor'
  else if E = 'windsurf.exe' then
    Friendly := 'Windsurf'
  else if (E = 'cmd.exe') or (E = 'powershell.exe') or (E = 'pwsh.exe') or (E = 'windowsterminal.exe') or (E = 'openconsole.exe')
    or (E = 'conhost.exe') or (E = 'bash.exe') or (E = 'mintty.exe') then
    Result := 2
  else if (E = 'explorer.exe') or (E = '') then
    Result := 0
  else
  begin
    Result := 3;
    Friendly := ExeName;
    if Copy(E, Length(E) - 3, 4) = '.exe' then
      Friendly := Copy(ExeName, 1, Length(ExeName) - 4);
  end;
end;

// Adds Item to a '|' separated list unless it is already there (case-insensitive).
procedure AddUnique(var List: String; const Item: String);
begin
  if Pos('|' + Lowercase(Item) + '|', '|' + Lowercase(List) + '|') > 0 then
    Exit;
  if List = '' then
    List := Item
  else
    List := List + '|' + Item;
end;

// 'a|b|c' becomes 'a, b and c'.
function HumanList(const List: String): String;
var
  Rest, Item: String;
  P: Integer;
begin
  Result := '';
  Rest := List;
  while Rest <> '' do
  begin
    P := Pos('|', Rest);
    if P = 0 then
    begin
      Item := Rest;
      Rest := '';
    end else
    begin
      Item := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, Length(Rest));
    end;
    if Result = '' then
      Result := Item
    else if Rest = '' then
      Result := Result + ' and ' + Item
    else
      Result := Result + ', ' + Item;
  end;
end;

// '' when nothing from the install folder is running. Otherwise the message: abfc is running and which program keeps it open
// (the first process above it that is not in the install folder). When WMI cannot be used the check is skipped (returns '').
function RunningAbfcMessage(Interactive: Boolean): String;
var
  AppPrefix, Editors, Terminals, Others, Phrases, Actions, Friendly, Tail: String;
  I, Cur, Parent, Depth, Kind, OwnKind: Integer;
  Found, Unowned, SawTerminal: Boolean;
  OwnFriendly: String;
begin
  Result := '';
  try
    LoadProcesses();
  except
    Log('Running-process check skipped: ' + GetExceptionMessage);
    Exit;
  end;
  AppPrefix := PathKey(ExpandConstant('{app}'));
  while (Length(AppPrefix) > 0) and (AppPrefix[Length(AppPrefix)] = '\') do
    Delete(AppPrefix, Length(AppPrefix), 1);
  if AppPrefix = '' then
    Exit;
  AppPrefix := AppPrefix + '\';

  Found := False;
  Unowned := False;
  Editors := '';
  Terminals := '';
  Others := '';
  for I := 0 to GetArrayLength(ProcPid) - 1 do
  begin
    if not IsInsideApp(I, AppPrefix) then
      Continue;
    Found := True;
    Log('abfc process still running: ' + ProcPath[I] + ' (pid ' + IntToStr(ProcPid[I]) + ')');
    Cur := I;
    Kind := 0;
    Friendly := '';
    SawTerminal := False;
    for Depth := 1 to 10 do
    begin
      Parent := IndexOfPid(ProcParent[Cur]);
      if (Parent < 0) or (Parent = Cur) then
        Break;
      if IsInsideApp(Parent, AppPrefix) then
        Cur := Parent
      else
      begin
        OwnKind := OwnerKind(ProcName[Parent], OwnFriendly);
        if OwnKind = 2 then
        begin
          // A shell or console host may only be the wrapper an editor starts the server through: remember it, keep walking.
          SawTerminal := True;
          Cur := Parent;
          Continue;
        end;
        Kind := OwnKind;
        Friendly := OwnFriendly;
        Break;
      end;
    end;
    // An editor found within the depth limit wins; otherwise a shell on the way means a terminal.
    if (Kind <> 1) and SawTerminal then
      Kind := 2;
    if Kind = 1 then
      AddUnique(Editors, Friendly)
    else if Kind = 2 then
      AddUnique(Terminals, 'terminal')
    else if Kind = 3 then
      AddUnique(Others, Friendly)
    else
      Unowned := True;
  end;
  if not Found then
    Exit;

  if Interactive then
    Tail := ', then click Retry.'
  else
    Tail := ', then run setup again.';

  Phrases := '';
  Actions := '';
  if Editors <> '' then
  begin
    AddUnique(Phrases, HumanList(Editors) + ' (the abfc language server)');
    AddUnique(Actions, 'close ' + HumanList(Editors));
  end;
  if Terminals <> '' then
  begin
    AddUnique(Phrases, 'a terminal (an abfc command is still running there)');
    AddUnique(Actions, 'finish or close that command');
  end;
  if Others <> '' then
  begin
    AddUnique(Phrases, HumanList(Others));
    AddUnique(Actions, 'close ' + HumanList(Others));
  end;

  if Phrases = '' then
  begin
    Result := 'abfc.exe is still running.' + #13#10#13#10 + 'Close the program that uses it (or end abfc.exe in Task Manager)' + Tail;
    Exit;
  end;
  Result := 'abfc.exe is still open, started by ' + HumanList(Phrases) + '.' + #13#10#13#10;
  Actions := HumanList(Actions);
  Result := Result + Uppercase(Copy(Actions, 1, 1)) + Copy(Actions, 2, Length(Actions)) + Tail;
  if Unowned then
    Result := Result + #13#10#13#10 + 'Another abfc.exe has no known owner: end it in Task Manager if it stays.';
end;

// Runs before the files are copied. Replacing abfc.exe fails with "Access is denied" while it runs, and an editor restarts it
// as soon as it is killed: so say what keeps it open and let the user close that.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Msg: String;
begin
  Result := '';
  while True do
  begin
    Msg := RunningAbfcMessage(not WizardSilent);
    if Msg = '' then
      Exit;
    Log(Msg);
    if WizardSilent then
    begin
      Result := Msg;
      Exit;
    end;
    if MsgBox(Msg, mbError, MB_RETRYCANCEL) <> IDRETRY then
    begin
      Result := 'abfc.exe is still running; setup was cancelled.';
      Exit;
    end;
  end;
end;

// The same check before the uninstaller deletes abfc.exe.
function InitializeUninstall(): Boolean;
var
  Msg: String;
begin
  Result := True;
  while True do
  begin
    Msg := RunningAbfcMessage(not UninstallSilent);
    if Msg = '' then
      Exit;
    Log(Msg);
    if UninstallSilent then
    begin
      Result := False;
      Exit;
    end;
    if MsgBox(Msg, mbError, MB_RETRYCANCEL) <> IDRETRY then
    begin
      Result := False;
      Exit;
    end;
  end;
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
