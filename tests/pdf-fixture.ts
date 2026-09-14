// Construct ordinary PDF objects rather than depending on the production parser.
export const pdfFixture = (pages: ReadonlyArray<ReadonlyArray<string>>) => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  const kids: string[] = [];

  for (const lines of pages) {
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 20000] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
    );
    const content = `BT /F1 12 Tf 20 19000 Td ${lines.map((line) => `(${line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj 0 -16 Td`).join(" ")} ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }

  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;

  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;

  return Buffer.from(
    `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
  );
};

export const denseLines = Array.from(
  { length: 600 },
  (_, i) =>
    `TOKEN${String(i).padStart(4, "0")} A distinct observation about energy systems and changing demand.`,
);

export const pagedPdf = pdfFixture([
  denseLines,
  ["SECOND_PAGE_ONLY", "A second page paragraph.", "More material on the second page."],
  ["THIRD_PAGE_ONLY", "A third page paragraph.", "More material on the third page."],
  ["FOURTH_PAGE_ONLY", "Final page paragraph.", "End of the document."],
]);
