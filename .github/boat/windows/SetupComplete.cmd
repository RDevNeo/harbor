@echo off
rem Run by Windows once setup is done, as SYSTEM, before the first logon (autounattend.xml copies it here).
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Windows\Setup\Scripts\harbor-setup.ps1 C:\Windows\Setup\Scripts > C:\Windows\Setup\Scripts\harbor-setup.log 2>&1
