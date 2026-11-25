import { expect, test } from "bun:test";
import { folderName, freeName, isForeignPathName, isWindowsPath, pathKey, pathTail, samePath } from "../src/projectpath.ts";

test("a path's last part, whatever system wrote it", () => {
  expect(pathTail("C:\\Users\\sam\\Projects\\app")).toBe("app");
  expect(pathTail("C:\\Users\\sam\\Projects\\app\\")).toBe("app");
  expect(pathTail("c:/Users/sam/app")).toBe("app");
  expect(pathTail("\\\\?\\C:\\Users\\sam\\app")).toBe("app");
  expect(pathTail("\\\\server\\share\\app")).toBe("app");
  expect(pathTail("/home/sam/Documents/app")).toBe("app");
  expect(pathTail("/home/sam/Documents/app/")).toBe("app");
  expect(pathTail("app")).toBe("app");
  expect(pathTail("C:\\")).toBe("");
  expect(pathTail("/")).toBe("");
  expect(pathTail("")).toBe("");
});

test("Windows paths are told by their drive or share", () => {
  expect(isWindowsPath("C:\\Users\\sam")).toBe(true);
  expect(isWindowsPath("d:/work")).toBe(true);
  expect(isWindowsPath("C:")).toBe(true);
  expect(isWindowsPath("\\\\server\\share")).toBe(true);
  expect(isWindowsPath("/home/sam")).toBe(false);
  expect(isWindowsPath("C:notes")).toBe(false);
  expect(isWindowsPath("relative\\dir")).toBe(false);
});

test("the same folder compares the same from any PC: separators, case and trailing ones of a Windows path", () => {
  const win = "C:\\Users\\Sam\\Projects\\crm";
  for (const same of ["c:\\users\\sam\\projects\\crm", "C:/Users/Sam/Projects/crm", "C:\\Users\\Sam\\Projects\\crm\\", "C:\\\\Users\\Sam\\Projects\\crm", "\\\\?\\C:\\Users\\Sam\\Projects\\crm"]) {
    expect(samePath(win, same)).toBe(true);
  }
  expect(samePath(win, "C:\\Users\\Sam\\Projects\\crm-2")).toBe(false);
  expect(samePath(win, "D:\\Users\\Sam\\Projects\\crm")).toBe(false);
  expect(pathKey("C:\\")).toBe("c:/");
  expect(pathKey("\\\\Server\\Share\\App")).toBe("//server/share/app");
});

test("a POSIX path keeps its case; only repeated and trailing slashes don't count", () => {
  expect(samePath("/home/sam/app", "/home/sam/app/")).toBe(true);
  expect(samePath("/home/sam//app", "/home/sam/app")).toBe(true);
  expect(samePath("/home/sam/App", "/home/sam/app")).toBe(false);
  expect(samePath("", "")).toBe(true);
  expect(samePath("", "/")).toBe(false);
  expect(pathKey("/")).toBe("/");
});

test("a folder name every system takes: another system's whole path gives its last part", () => {
  expect(folderName("C:\\Users\\Sam\\Projects\\crm")).toBe("crm");
  expect(folderName("/home/sam/Documents/app")).toBe("app");
  expect(folderName("app")).toBe("app");
  expect(folderName("My App")).toBe("My App");
  expect(folderName('a<b>c:d"e|f?g*h')).toBe("a-b-c-d-e-f-g-h");
  expect(folderName("tab\there")).toBe("tab-here");
  expect(folderName("..hidden.")).toBe("hidden");
  expect(folderName("  spaced  ")).toBe("spaced");
  expect(folderName("CON")).toBe("CON-project");
  expect(folderName("nul.txt")).toBe("nul.txt-project");
  expect(folderName("console")).toBe("console");
  expect(folderName("C:\\")).toBe("project");
  expect(folderName("", "chat")).toBe("chat");
  expect(folderName("???")).toBe("project");
  expect(folderName("x".repeat(300)).length).toBe(100);
});

test("folders Hub named after another system's whole path are told apart from plain names", () => {
  expect(isForeignPathName("C:\\Users\\Sam\\Projects\\crm")).toBe(true);
  expect(isForeignPathName("D:")).toBe(true);
  expect(isForeignPathName("a\\b")).toBe(true);
  expect(isForeignPathName("crm")).toBe(false);
  // A colon a Linux user put in a name of their own is theirs to keep.
  expect(isForeignPathName("notes:2024")).toBe(false);
  expect(isForeignPathName("my app (v2)")).toBe(false);
});

test("a free name: the wanted one, else with -2, -3…", () => {
  const taken = new Set(["app", "app-2"]);
  expect(freeName("app", (n) => taken.has(n))).toBe("app-3");
  expect(freeName("web", (n) => taken.has(n))).toBe("web");
});
