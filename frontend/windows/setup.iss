[Setup]
AppId={{8E9D5C31-7A2F-4B18-9F60-4B15A8E9D210}
AppName=ISHIT
AppVersion=beta
AppPublisher=ISHIT
DefaultDirName={autopf}\ISHIT
DefaultGroupName=ISHIT
AllowNoIcons=yes
OutputDir=E:\LynnH Ma\Progarmming\ISHIT\dist
OutputBaseFilename=ISHIT-Windows-Setup
SetupIconFile=E:\LynnH Ma\Progarmming\ISHIT\frontend\windows\app.ico
UninstallDisplayIcon={app}\ISHIT.exe
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "E:\LynnH Ma\Progarmming\ISHIT\frontend\windows\publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\ISHIT"; Filename: "{app}\ISHIT.exe"
Name: "{group}\卸载 ISHIT"; Filename: "{uninstallexe}"
Name: "{autodesktop}\ISHIT"; Filename: "{app}\ISHIT.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\ISHIT.exe"; Description: "{cm:LaunchProgram,ISHIT}"; Flags: nowait postinstall skipifsilent
