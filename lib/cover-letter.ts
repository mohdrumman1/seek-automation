import * as fs from 'fs';
import * as path from 'path';

const CL_PATH = path.resolve(__dirname, '../data/CoverLetter.txt');

export function readBaseCoverLetter(): string {
  if (!fs.existsSync(CL_PATH)) {
    throw new Error(
      `Cover letter not found at ${CL_PATH}.\n` +
        `Run the one-time DOCX export from the Automation folder first:\n` +
        `python -c "from docx import Document; doc = Document(r'C:\\Users\\mohdr\\OneDrive\\Desktop\\Job Application\\Automation\\CoverLetter.docx'); open(r'${CL_PATH}', 'w').write('\\n'.join(p.text for p in doc.paragraphs if p.text.strip()))"`
    );
  }
  return fs.readFileSync(CL_PATH, 'utf-8');
}
