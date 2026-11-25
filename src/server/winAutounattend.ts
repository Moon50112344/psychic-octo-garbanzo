import fs from 'node:fs';

export function resolvePreferredWimImageIndex(isoPath: string, osId: 'windows-7' | 'windows-10'): number {
  const defaultIndex = osId === 'windows-7' ? 4 : 1;
  try {
    if (!fs.existsSync(isoPath)) return defaultIndex;
    const fd = fs.openSync(isoPath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const chunkSize = 4 * 1024 * 1024;
      const overlap = 16;
      const buf = Buffer.allocUnsafe(chunkSize + overlap);
      const magic = Buffer.from([0x4d, 0x53, 0x57, 0x49, 0x4d, 0x00, 0x00, 0x00]); // "MSWIM\0\0\0"
      const headerBuf = Buffer.allocUnsafe(208);

      let offset = 0;
      let carry = 0;
      while (offset < stat.size) {
        const toRead = Math.min(chunkSize, stat.size - offset);
        const bytesRead = fs.readSync(fd, buf, carry, toRead, offset);
        if (bytesRead <= 0) break;
        const windowLen = carry + bytesRead;

        let searchFrom = 0;
        while (searchFrom < windowLen) {
          const idx = buf.indexOf(magic, searchFrom);
          if (idx < 0) break;
          const absPos = offset - carry + idx;
          if (absPos % 2048 === 0 && absPos + 208 <= stat.size) {
            fs.readSync(fd, headerBuf, 0, 208, absPos);
            const cbSize = headerBuf.readUInt32LE(8);
            const imageCount = headerBuf.readUInt32LE(44);
            const xmlFlagsAndSize = headerBuf.readBigUInt64LE(72);
            const xmlOffset = Number(headerBuf.readBigUInt64LE(80));
            const xmlSize = Number(xmlFlagsAndSize & 0x00ffffffffffffffn);

            if (cbSize === 208 && imageCount >= 1 && xmlSize > 64 && xmlSize < 512 * 1024 && absPos + xmlOffset + xmlSize <= stat.size) {
              const xmlRaw = Buffer.allocUnsafe(xmlSize);
              fs.readSync(fd, xmlRaw, 0, xmlSize, absPos + xmlOffset);
              const xmlText = xmlRaw.toString('utf16le');
              // Skip boot.wim (WindowsPE); inspect install.wim (Client/Server)
              if (xmlText.includes('<INSTALLATIONTYPE>Client</INSTALLATIONTYPE>') || xmlText.includes('<NAME>Windows')) {
                const matches = Array.from(xmlText.matchAll(/<IMAGE INDEX="(\d+)">[\s\S]*?<NAME>([^<]+)<\/NAME>/gi));
                if (matches.length > 0) {
                  if (osId === 'windows-7') {
                    const ult = matches.find((m) => /ultimate/i.test(m[2]));
                    if (ult) return Number(ult[1]);
                    const pro = matches.find((m) => /professional/i.test(m[2]));
                    if (pro) return Number(pro[1]);
                  } else {
                    const iotLtsc = matches.find((m) => /iot.*ltsc/i.test(m[2]));
                    if (iotLtsc) return Number(iotLtsc[1]);
                    const ltsc = matches.find((m) => /ltsc/i.test(m[2]));
                    if (ltsc) return Number(ltsc[1]);
                    const ent = matches.find((m) => /enterprise/i.test(m[2]));
                    if (ent) return Number(ent[1]);
                    const pro = matches.find((m) => /\bpro\b/i.test(m[2]) && !/education|workstation/i.test(m[2]));
                    if (pro) return Number(pro[1]);
                  }
                  return Number(matches[0][1]) || 1;
                }
              }
            }
          }
          searchFrom = idx + 8;
        }

        const tail = Math.min(overlap, windowLen);
        buf.copy(buf, 0, windowLen - tail, windowLen);
        carry = tail;
        offset += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // fallback safely
  }
  return defaultIndex;
}

export function buildWindowsAutounattendXml(opts: {
  osId: 'windows-7' | 'windows-10';
  username: string;
  password: string;
  computerName?: string;
  wimIndex?: number;
  installCredSyncTask?: boolean;
  shutdownAfterFirstLogon?: boolean;
}): string {
  const escapeXml = (str: string) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const escapedPwd = escapeXml(opts.password);
  const escapedUser = escapeXml(opts.username || 'Administrator');
  const computerName = escapeXml((opts.computerName || 'MOONVPS').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 15) || 'MOONVPS');
  const wimIndex = opts.wimIndex || (opts.osId === 'windows-7' ? 4 : 1);
  const isBuiltInAdmin = (opts.username || 'Administrator').toLowerCase() === 'administrator';

  const localAccountsBlock = !isBuiltInAdmin
    ? [
        '        <LocalAccounts>',
        '          <LocalAccount wcm:action="add">',
        '            <Password>',
        `              <Value>${escapedPwd}</Value>`,
        '              <PlainText>true</PlainText>',
        '            </Password>',
        `            <Name>${escapedUser}</Name>`,
        `            <DisplayName>${escapedUser}</DisplayName>`,
        '            <Group>Administrators</Group>',
        '            <Description>Moon Studio Windows Administrator</Description>',
        '          </LocalAccount>',
        '        </LocalAccounts>',
      ].join('\n')
    : '';

  const diskConfigBlock =
    opts.osId === 'windows-10'
      ? [
          '      <DiskConfiguration>',
          '        <WillShowUI>OnError</WillShowUI>',
          '        <Disk wcm:action="add">',
          '          <DiskID>0</DiskID>',
          '          <WillWipeDisk>true</WillWipeDisk>',
          '          <CreatePartitions>',
          '            <CreatePartition wcm:action="add">',
          '              <Order>1</Order>',
          '              <Type>EFI</Type>',
          '              <Size>100</Size>',
          '            </CreatePartition>',
          '            <CreatePartition wcm:action="add">',
          '              <Order>2</Order>',
          '              <Type>MSR</Type>',
          '              <Size>16</Size>',
          '            </CreatePartition>',
          '            <CreatePartition wcm:action="add">',
          '              <Order>3</Order>',
          '              <Type>Primary</Type>',
          '              <Extend>true</Extend>',
          '            </CreatePartition>',
          '          </CreatePartitions>',
          '          <ModifyPartitions>',
          '            <ModifyPartition wcm:action="add">',
          '              <Order>1</Order>',
          '              <PartitionID>1</PartitionID>',
          '              <Label>System</Label>',
          '              <Format>FAT32</Format>',
          '            </ModifyPartition>',
          '            <ModifyPartition wcm:action="add">',
          '              <Order>2</Order>',
          '              <PartitionID>2</PartitionID>',
          '            </ModifyPartition>',
          '            <ModifyPartition wcm:action="add">',
          '              <Order>3</Order>',
          '              <PartitionID>3</PartitionID>',
          '              <Label>Windows</Label>',
          '              <Letter>C</Letter>',
          '              <Format>NTFS</Format>',
          '            </ModifyPartition>',
          '          </ModifyPartitions>',
          '        </Disk>',
          '      </DiskConfiguration>',
          '      <ImageInstall>',
          '        <OSImage>',
          '          <InstallFrom>',
          '            <MetaData wcm:action="add">',
          '              <Key>/IMAGE/INDEX</Key>',
          `              <Value>${wimIndex}</Value>`,
          '            </MetaData>',
          '          </InstallFrom>',
          '          <InstallTo>',
          '            <DiskID>0</DiskID>',
          '            <PartitionID>3</PartitionID>',
          '          </InstallTo>',
          '          <WillShowUI>OnError</WillShowUI>',
          '          <InstallToAvailablePartition>false</InstallToAvailablePartition>',
          '        </OSImage>',
          '      </ImageInstall>',
        ]
      : [
          '      <DiskConfiguration>',
          '        <WillShowUI>OnError</WillShowUI>',
          '        <Disk wcm:action="add">',
          '          <DiskID>0</DiskID>',
          '          <WillWipeDisk>true</WillWipeDisk>',
          '          <CreatePartitions>',
          '            <CreatePartition wcm:action="add">',
          '              <Order>1</Order>',
          '              <Type>Primary</Type>',
          '              <Extend>true</Extend>',
          '            </CreatePartition>',
          '          </CreatePartitions>',
          '          <ModifyPartitions>',
          '            <ModifyPartition wcm:action="add">',
          '              <Order>1</Order>',
          '              <PartitionID>1</PartitionID>',
          '              <Active>true</Active>',
          '              <Format>NTFS</Format>',
          '              <Label>Windows</Label>',
          '              <Letter>C</Letter>',
          '            </ModifyPartition>',
          '          </ModifyPartitions>',
          '        </Disk>',
          '      </DiskConfiguration>',
          '      <ImageInstall>',
          '        <OSImage>',
          '          <InstallFrom>',
          '            <MetaData wcm:action="add">',
          '              <Key>/IMAGE/INDEX</Key>',
          `              <Value>${wimIndex}</Value>`,
          '            </MetaData>',
          '          </InstallFrom>',
          '          <InstallTo>',
          '            <DiskID>0</DiskID>',
          '            <PartitionID>1</PartitionID>',
          '          </InstallTo>',
          '          <WillShowUI>OnError</WillShowUI>',
          '        </OSImage>',
          '      </ImageInstall>',
        ];

  const credSyncTaskXml = opts.installCredSyncTask
    ? [
        '        <SynchronousCommand wcm:action="add">',
        '          <Order>2</Order>',
        '          <Description>Register Moon Studio startup credential sync task for instant clones</Description>',
        '          <CommandLine>cmd /c schtasks /create /tn "MoonStudioCredSync" /tr "powershell -NoProfile -ExecutionPolicy Bypass -Command \\"Get-PSDrive -PSProvider FileSystem | ForEach-Object { $p = Join-Path $_.Root \'sync-cred.cmd\'; if (Test-Path $p) { &amp; cmd.exe /c $p } }\\"" /sc onstart /ru SYSTEM /f</CommandLine>',
        '        </SynchronousCommand>',
      ]
    : [];

  const shutdownOrder = opts.installCredSyncTask ? 3 : 2;
  const shutdownXml = opts.shutdownAfterFirstLogon
    ? [
        '        <SynchronousCommand wcm:action="add">',
        `          <Order>${shutdownOrder}</Order>`,
        '          <Description>Seal pre-installed Windows 10 base image cleanly</Description>',
        '          <CommandLine>cmd /c shutdown /s /t 5</CommandLine>',
        '        </SynchronousCommand>',
      ]
    : [];

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">',
    '  <settings pass="windowsPE">',
    '    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <SetupUILanguage>',
    '        <UILanguage>en-US</UILanguage>',
    '      </SetupUILanguage>',
    '      <InputLocale>en-US</InputLocale>',
    '      <SystemLocale>en-US</SystemLocale>',
    '      <UILanguage>en-US</UILanguage>',
    '      <UserLocale>en-US</UserLocale>',
    '    </component>',
    '    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    ...diskConfigBlock,
    ...(opts.osId === 'windows-10'
      ? [
          '      <DynamicUpdate>',
          '        <Enable>false</Enable>',
          '        <WillShowUI>Never</WillShowUI>',
          '      </DynamicUpdate>',
          '      <UpgradeData>',
          '        <Upgrade>false</Upgrade>',
          '        <WillShowUI>Never</WillShowUI>',
          '      </UpgradeData>',
        ]
      : []),
    '      <UserData>',
    '        <AcceptEula>true</AcceptEula>',
    `        <FullName>${escapedUser}</FullName>`,
    '        <Organization>Moon Studio</Organization>',
    ...(opts.osId === 'windows-10'
      ? [
          '        <ProductKey>',
          '          <Key />',
          '        </ProductKey>',
        ]
      : [
          '        <ProductKey>',
          '          <Key />',
          '          <WillShowUI>OnError</WillShowUI>',
          '        </ProductKey>',
        ]),
    '      </UserData>',
    '    </component>',
    '  </settings>',
    '  <settings pass="specialize">',
    '    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    `      <ComputerName>${computerName}</ComputerName>`,
    '      <TimeZone>UTC</TimeZone>',
    '    </component>',
    '    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <RunSynchronous>',
    '        <RunSynchronousCommand wcm:action="add">',
    '          <Order>1</Order>',
    '          <Path>cmd /c reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power" /v HibernateEnabled /t REG_DWORD /d 0 /f</Path>',
    '          <Description>Disable hiberfil.sys to save disk and container RAM</Description>',
    '        </RunSynchronousCommand>',
    '        <RunSynchronousCommand wcm:action="add">',
    '          <Order>2</Order>',
    '          <Path>cmd /c reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" /v PagingFiles /t REG_MULTI_SZ /d "C:\\pagefile.sys 256 512" /f</Path>',
    '          <Description>Cap pagefile size for low-footprint TCG QEMU operation</Description>',
    '        </RunSynchronousCommand>',
    '        <RunSynchronousCommand wcm:action="add">',
    '          <Order>3</Order>',
    '          <Path>cmd /c sc config SysMain start= disabled &amp; sc config WSearch start= disabled &amp; sc config wuauserv start= disabled &amp; sc config WerSvc start= disabled</Path>',
    '          <Description>Disable heavy background services (SuperFetch, Search, Windows Update)</Description>',
    '        </RunSynchronousCommand>',
    '        <RunSynchronousCommand wcm:action="add">',
    '          <Order>4</Order>',
    '          <Path>cmd /c reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f &amp; reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" /v UserAuthentication /t REG_DWORD /d 0 /f &amp; netsh advfirewall firewall set rule group="remote desktop" new enable=Yes</Path>',
    '          <Description>Enable Remote Desktop and firewall exception early in specialize</Description>',
    '        </RunSynchronousCommand>',
    '      </RunSynchronous>',
    '    </component>',
    '    <component name="Microsoft-Windows-TerminalServices-LocalSessionManager" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <fDenyTSConnections>false</fDenyTSConnections>',
    '    </component>',
    ...(opts.osId === 'windows-10'
      ? [
          '    <component name="Microsoft-Windows-Security-SPP-UX" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
          '      <SkipAutoActivation>true</SkipAutoActivation>',
          '    </component>',
          '    <component name="Microsoft-Windows-TerminalServices-RDP-WinStationExtensions" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
          '      <UserAuthentication>0</UserAuthentication>',
          '    </component>',
        ]
      : []),
    '    <component name="Networking-MPSSVC-Svc" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <FirewallGroups>',
    '        <FirewallGroup wcm:action="add" wcm:keyValue="RemoteDesktop">',
    '          <Active>true</Active>',
    '          <Group>Remote Desktop</Group>',
    '          <Profile>all</Profile>',
    '        </FirewallGroup>',
    '      </FirewallGroups>',
    '    </component>',
    '  </settings>',
    '  <settings pass="oobeSystem">',
    '    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <InputLocale>en-US</InputLocale>',
    '      <SystemLocale>en-US</SystemLocale>',
    '      <UILanguage>en-US</UILanguage>',
    '      <UserLocale>en-US</UserLocale>',
    '    </component>',
    ...(opts.osId === 'windows-10'
      ? [
          '    <component name="Microsoft-Windows-SecureStartup-FilterDriver" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
          '      <PreventDeviceEncryption>true</PreventDeviceEncryption>',
          '    </component>',
        ]
      : []),
    '    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <OOBE>',
    '        <HideEULAPage>true</HideEULAPage>',
    ...(opts.osId === 'windows-10'
      ? [
          '        <HideLocalAccountScreen>true</HideLocalAccountScreen>',
          '        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>',
          '        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>',
          '        <SkipUserOOBE>true</SkipUserOOBE>',
          '        <SkipMachineOOBE>true</SkipMachineOOBE>',
        ]
      : []),
    '        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>',
    '        <NetworkLocation>Work</NetworkLocation>',
    '        <ProtectYourPC>3</ProtectYourPC>',
    '      </OOBE>',
    '      <UserAccounts>',
    '        <AdministratorPassword>',
    `          <Value>${escapedPwd}</Value>`,
    '          <PlainText>true</PlainText>',
    '        </AdministratorPassword>',
    ...(localAccountsBlock ? [localAccountsBlock] : []),
    '      </UserAccounts>',
    '      <AutoLogon>',
    '        <Password>',
    `          <Value>${escapedPwd}</Value>`,
    '          <PlainText>true</PlainText>',
    '        </Password>',
    '        <Enabled>true</Enabled>',
    `        <Username>${escapedUser}</Username>`,
    '      </AutoLogon>',
    '      <FirstLogonCommands>',
    '        <SynchronousCommand wcm:action="add">',
    '          <Order>1</Order>',
    '          <Description>Ensure hibernation off and Remote Desktop active</Description>',
    '          <CommandLine>cmd /c powercfg -h off &amp; reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f &amp; reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" /v UserAuthentication /t REG_DWORD /d 0 /f &amp; netsh advfirewall firewall set rule group="remote desktop" new enable=Yes</CommandLine>',
    '        </SynchronousCommand>',
    ...credSyncTaskXml,
    ...shutdownXml,
    '      </FirstLogonCommands>',
    '    </component>',
    '  </settings>',
    '</unattend>',
    '',
  ].join('\n');
}

export function buildCredentialSyncScript(username: string, password: string): string {
  const safeUser = (username || 'Administrator').replace(/["^&|<>]/g, '');
  const escapedCmdPwd = password.replace(/"/g, '""');
  return [
    '@echo off',
    `net user "${safeUser}" "${escapedCmdPwd}" /active:yes >nul 2>&1 || net user "${safeUser}" "${escapedCmdPwd}" /add /Y >nul 2>&1`,
    `net localgroup Administrators "${safeUser}" /add >nul 2>&1`,
    'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f >nul 2>&1',
    'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" /v UserAuthentication /t REG_DWORD /d 0 /f >nul 2>&1',
    'netsh advfirewall firewall set rule group="remote desktop" new enable=Yes >nul 2>&1',
    'exit /b 0',
    '',
  ].join('\r\n');
}
