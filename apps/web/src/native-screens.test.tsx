import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { uiComponents } from "./native-ui";

const { Page, Section, Table, ListItem } = uiComponents;

test("a page says where you are, searches what it shows, and opens an inspector beside it", () => {
  const html = renderToStaticMarkup(
    <Page
      title={[{ title: "Team Drive", onPress: () => {} }, { title: "Launch" }]}
      subtitle="aspen@example.com"
      search={{
        placeholder: "Search Team Drive",
        value: "",
        onChange: () => {},
      }}
      inspector={{ title: "Logo.png", content: "PNG image", onClose: () => {} }}
    >
      rows
    </Page>,
  );
  expect(html).toContain("data-screen");
  expect(html).toMatch(/<button[^>]*>Team Drive<\/button>/);
  expect(html).toMatch(/<h1[^>]*aria-current="location"[^>]*>Launch<\/h1>/);
  expect(html).toContain('placeholder="Search Team Drive"');
  expect(html).toMatch(/<aside aria-label="Logo.png"/);
});

const columns = [
  { key: "name", title: "Name" },
  { key: "size", title: "Size", align: "end" as const },
];
const rows = [
  {
    id: "a",
    icon: "file-text",
    cells: { name: "Roadmap.pdf", size: "1.2 MB" },
  },
  { id: "b", icon: "folder", cells: { name: "Press", size: "—" } },
];

test("a table shows what is chosen and how it is sorted, or says it is empty", () => {
  const html = renderToStaticMarkup(
    <Table
      columns={columns}
      rows={rows}
      selected={["b"]}
      onSelect={() => {}}
      sort={{ key: "name" }}
      onSort={() => {}}
    />,
  );
  expect(html).toContain('aria-multiselectable="true"');
  expect(html).toMatch(/<tr aria-selected="false"[^>]*data-row="a"/);
  expect(html).toMatch(/<tr aria-selected="true"[^>]*data-row="b"/);
  expect(html).toMatch(/<th aria-sort="ascending"/);
  expect(
    renderToStaticMarkup(
      <Table columns={columns} rows={[]} empty="No files" />,
    ),
  ).toContain("No files");
});

test("a table as icons names each by its first column", () => {
  const html = renderToStaticMarkup(
    <Table columns={columns} rows={rows} view="icons" />,
  );
  expect(html).not.toContain("<table");
  expect(html).toMatch(/data-row="a"[\s\S]*Roadmap.pdf/);
  expect(html).not.toContain("1.2 MB");
});

test("a section names its rows and holds them in a list", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Section title="Linear · Northwind">
        <ListItem
          title="Website"
          menu={[{ title: "Open", onPress: () => {} }]}
        />
      </Section>
    </MemoryRouter>,
  );
  expect(html).toMatch(/<section aria-label="Linear · Northwind"/);
  expect(html).toMatch(/<ul[^>]*><li/);
  expect(html).toContain('aria-label="Website actions"');
});
