import * as fs from 'fs';
import * as path from 'path';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  TableRow,
  TableCell,
  Table,
  WidthType,
  UnderlineType,
} from 'docx';
import type { TailoredContent } from './resume-tailor';

const TMP_DIR = path.resolve(__dirname, '../tmp');

// Header is static — pulled from the base resume. Hardcoded here so the
// generator never needs to parse the DOCX just to get contact info.
const CONTACT = {
  name: 'RUMMAN (MOHAMMED) RIYAZ',
  phone: '+61 474 199 245',
  email: 'mohdrumman1@gmail.com',
  linkedin: 'linkedin.com/in/rumman-riyaz',
};

const EDUCATION_PM = [
  'Bachelor of Computer Engineering (Honours) — University of Newcastle',
  'Project Management Professional (PMP) — Project Management Institute',
  'AWS Certified Cloud Practitioner',
];

const EDUCATION_SE = [
  'Bachelor of Computer Engineering (Honours) — University of Newcastle',
  'Project Management Professional (PMP) — Project Management Institute',
  'AWS Certified Cloud Practitioner',
];

function hr(): Paragraph {
  return new Paragraph({
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    },
    spacing: { after: 120 },
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        size: 22,
        font: 'Calibri',
      }),
    ],
    spacing: { before: 200, after: 80 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: '666666' },
    },
  });
}

function body(text: string, opts: { bold?: boolean; italic?: boolean; size?: number } = {}): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italic,
        size: opts.size ?? 20,
        font: 'Calibri',
      }),
    ],
    spacing: { after: 60 },
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    children: [
      new TextRun({
        text,
        size: 20,
        font: 'Calibri',
      }),
    ],
    spacing: { after: 60 },
  });
}

function buildSkillParagraphs(skillsText: string): Paragraph[] {
  return skillsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0 && colonIdx < 40) {
        const label = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        return new Paragraph({
          children: [
            new TextRun({ text: label + ': ', bold: true, size: 20, font: 'Calibri' }),
            new TextRun({ text: value, size: 20, font: 'Calibri' }),
          ],
          spacing: { after: 60 },
        });
      }
      return body(line);
    });
}

export async function generateTailoredDocx(
  tailored: TailoredContent,
  jobId: string,
  company?: string,
): Promise<string> {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  const education = tailored.variant === 'pm' ? EDUCATION_PM : EDUCATION_SE;

  const children: Paragraph[] = [
    // Name
    new Paragraph({
      children: [
        new TextRun({
          text: CONTACT.name,
          bold: true,
          size: 32,
          font: 'Calibri',
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
    }),

    // Tailored title
    new Paragraph({
      children: [
        new TextRun({
          text: tailored.title,
          size: 24,
          font: 'Calibri',
          color: '444444',
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
    }),

    // Contact line
    new Paragraph({
      children: [
        new TextRun({
          text: `${CONTACT.phone}  |  ${CONTACT.email}  |  ${CONTACT.linkedin}`,
          size: 18,
          font: 'Calibri',
          color: '555555',
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
    }),

    sectionHeading('Professional Summary'),
    body(tailored.summary),

    sectionHeading(tailored.variant === 'pm' ? 'Skills & Delivery Expertise' : 'Technical Skills'),
    ...buildSkillParagraphs(tailored.skills),

    sectionHeading('Professional Experience'),
  ];

  for (const role of tailored.experience) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: role.company, bold: true, size: 22, font: 'Calibri' }),
        ],
        spacing: { before: 120, after: 20 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: role.role, bold: true, size: 20, font: 'Calibri' }),
          new TextRun({ text: '  |  ' + role.period, size: 20, font: 'Calibri', color: '555555' }),
        ],
        spacing: { after: 60 },
      }),
    );
    for (const b of role.bullets) {
      children.push(bullet(b));
    }
  }

  children.push(sectionHeading('Education & Certifications'));
  for (const line of education) {
    children.push(body(line));
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 20 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 900, right: 900 },
          },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const safeCo = company
    ? company.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
    : jobId;
  const outputPath = path.join(TMP_DIR, `Rumman_${safeCo}_${date}.docx`);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}
