@echo off
setlocal enabledelayedexpansion
rem dsh-bridge MCP stdio 启动器。
rem Kimi Work 宿主的 PATH 里通常没有 node，所以这里自己找，找不到就明确报错。
rem 查找顺序：DSH_BRIDGE_NODE > 本目录 node-path.txt（部署脚本生成）> DSH 运行时 node > PATH 里的 node

set "HERE=%~dp0"
set "MCP_SCRIPT=%HERE%dsh-bridge-mcp.mjs"
set "NODE_EXE="

if not "%DSH_BRIDGE_NODE%"=="" if exist "%DSH_BRIDGE_NODE%" set "NODE_EXE=%DSH_BRIDGE_NODE%"

if not defined NODE_EXE if exist "%HERE%node-path.txt" (
  for /f "usebackq delims=" %%P in ("%HERE%node-path.txt") do (
    if not defined NODE_EXE if exist "%%~fP" set "NODE_EXE=%%~fP"
  )
)

if not defined NODE_EXE (
  for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if not defined NODE_EXE if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE_EXE=%%~fD\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  for /f "delims=" %%P in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%~fP"
  )
)

if not defined NODE_EXE (
  echo [dsh-bridge] node.exe not found. Set DSH_BRIDGE_NODE, or put an absolute node path in node-path.txt next to this file. 1>&2
  exit /b 1
)

"%NODE_EXE%" "%MCP_SCRIPT%" %*
exit /b %ERRORLEVEL%
