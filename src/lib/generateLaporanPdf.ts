import PDFDocument from "pdfkit";
import type { PrismaClient } from "../generated/prisma/client.js";

interface TopikWithNilai {
  id: number;
  kode: string | null;
  judul: string | null;
  nilai_quiz: {
    nilai: number | null;
  } | null;
}

interface BabWithTopik {
  id: number;
  nomor: string | null;
  judul: string | null;
  topik: TopikWithNilai[];
}

interface LaporanData {
  pesertaDidik: {
    nama_lengkap: string | null;
    nisn: string | null;
  };
  kelas: {
    nama: string | null;
  };
  sekolah: {
    nama: string | null;
    alamat: string | null;
    semester: string | null;
    tahun_ajaran: string | null;
  };
  guru: {
    nama_lengkap: string | null;
    nip: string | null;
  } | null;
  babList: BabWithTopik[];
  tanggalCetak: Date;
}

function getPredikat(nilai: number | null): string {
  if (nilai === null) return "-";
  if (nilai >= 88) return "A";
  if (nilai >= 75) return "B";
  if (nilai >= 60) return "C";
  return "D";
}

function getStatus(babTopik: TopikWithNilai[]): string {
  const allCompleted = babTopik.every(
    (t) => t.nilai_quiz?.nilai !== null && t.nilai_quiz?.nilai !== undefined,
  );
  if (allCompleted) return "LULUS";
  const anyCompleted = babTopik.some(
    (t) => t.nilai_quiz?.nilai !== null && t.nilai_quiz?.nilai !== undefined,
  );
  if (anyCompleted) return "PROSES";
  return "-";
}

function calculateBabNilai(topikList: TopikWithNilai[]): number | null {
  const nilaiList = topikList
    .map((t) => t.nilai_quiz?.nilai)
    .filter((n): n is number => n !== null && n !== undefined);
  if (nilaiList.length === 0) return null;
  return Math.round(nilaiList.reduce((a, b) => a + b, 0) / nilaiList.length);
}

function calculateOverallStats(babList: BabWithTopik[]): {
  progressPeta: number;
  bintangTerkumpul: number;
  totalBintang: number;
  predikatPetualang: string;
} {
  let totalTopik = 0;
  let completedTopik = 0;
  let totalNilai = 0;
  let countNilai = 0;

  babList.forEach((bab) => {
    bab.topik.forEach((topik) => {
      totalTopik++;
      if (
        topik.nilai_quiz?.nilai !== null &&
        topik.nilai_quiz?.nilai !== undefined
      ) {
        completedTopik++;
        totalNilai += topik.nilai_quiz.nilai;
        countNilai++;
      }
    });
  });

  const progressPeta =
    totalTopik > 0 ? Math.round((completedTopik / totalTopik) * 100) : 0;
  const bintangTerkumpul = completedTopik;
  const totalBintang = totalTopik;
  const avgNilai = countNilai > 0 ? totalNilai / countNilai : 0;

  let predikatPetualang = "BELUM DINILAI";
  if (avgNilai >= 88) predikatPetualang = "SANGAT BAIK";
  else if (avgNilai >= 75) predikatPetualang = "BAIK";
  else if (avgNilai >= 60) predikatPetualang = "CUKUP";
  else if (countNilai > 0) predikatPetualang = "PERLU BIMBINGAN";

  return { progressPeta, bintangTerkumpul, totalBintang, predikatPetualang };
}

export async function generateLaporanPdf(
  prisma: PrismaClient,
  pesertaDidikId: number,
  guruId?: number,
): Promise<Buffer> {
  // Fetch peserta didik
  const pesertaDidik = await prisma.peserta_didik.findUnique({
    where: { id: pesertaDidikId },
    include: {
      kelas: {
        include: {
          sekolah: true,
        },
      },
    },
  });

  if (!pesertaDidik) {
    throw new Error("Peserta didik tidak ditemukan");
  }

  // Fetch guru if provided
  let guru = null;
  if (guruId) {
    guru = await prisma.guru.findUnique({
      where: { id: guruId },
    });
  }

  // Fetch bab list
  const babList = await prisma.bab.findMany({
    where: { kelas_id: pesertaDidik.kelas_id },
    orderBy: { id: "asc" },
  });

  // Fetch topik list
  const topikList = await prisma.topik.findMany({
    where: {
      bab_id: { in: babList.map((b) => b.id) },
    },
  });

  // Fetch nilai quiz
  const nilaiQuizList = await prisma.nilai_quiz.findMany({
    where: {
      peserta_didik_id: pesertaDidikId,
      topik_id: { in: topikList.map((t) => t.id) },
    },
    orderBy: { tanggal_selesai: "desc" },
  });

  // Fetch quiz for calculating scores
  const quizList = await prisma.quiz.findMany({
    where: {
      topik_id: { in: topikList.map((t) => t.id) },
    },
  });

  // Calculate best nilai for each topik
  const topikIdToBestNilai: Record<number, number | null> = {};

  topikList.forEach((topik) => {
    const percobaan = nilaiQuizList.filter((n) => n.topik_id === topik.id);
    let bestNilai: number | null = null;

    percobaan.forEach((nilaiQuiz) => {
      if (nilaiQuiz.hasil_quiz) {
        try {
          const hasilQuizArr: Array<{ quiz_id: number; jawaban: string }> =
            JSON.parse(nilaiQuiz.hasil_quiz.toString());
          let benar = 0;
          const total = hasilQuizArr.length;

          hasilQuizArr.forEach((jawabanObj) => {
            const quiz = quizList.find((q) => q.id === jawabanObj.quiz_id);
            if (quiz && quiz.jawaban === jawabanObj.jawaban) {
              benar++;
            }
          });

          const nilai = total > 0 ? Math.round((benar / total) * 100) : null;
          if (bestNilai === null || (nilai !== null && nilai > bestNilai)) {
            bestNilai = nilai;
          }
        } catch {
          // ignore parsing errors
        }
      }
    });

    topikIdToBestNilai[topik.id] = bestNilai;
  });

  // Build bab with topik structure
  const babWithTopik: BabWithTopik[] = babList.map((bab) => {
    const topikInBab = topikList
      .filter((t) => t.bab_id === bab.id)
      .sort((a, b) => (a.kode || "").localeCompare(b.kode || ""))
      .map((t) => ({
        id: t.id,
        kode: t.kode,
        judul: t.judul,
        nilai_quiz: {
          nilai: topikIdToBestNilai[t.id],
        },
      }));

    return {
      id: bab.id,
      nomor: bab.nomor,
      judul: bab.judul,
      topik: topikInBab,
    };
  });

  const laporanData: LaporanData = {
    pesertaDidik: {
      nama_lengkap: pesertaDidik.nama_lengkap,
      nisn: pesertaDidik.nisn,
    },
    kelas: {
      nama: pesertaDidik.kelas?.nama || null,
    },
    sekolah: {
      nama: pesertaDidik.kelas?.sekolah?.nama || null,
      alamat: pesertaDidik.kelas?.sekolah?.alamat || null,
      semester: pesertaDidik.kelas?.sekolah?.semester || null,
      tahun_ajaran: pesertaDidik.kelas?.sekolah?.tahun_ajaran || null,
    },
    guru: guru
      ? {
          nama_lengkap: guru.nama_lengkap,
          nip: guru.nip,
        }
      : null,
    babList: babWithTopik,
    tanggalCetak: new Date(),
  };

  return createPdfDocument(laporanData);
}

function createPdfDocument(data: LaporanData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - 80; // 40 left + 40 right margin
    const stats = calculateOverallStats(data.babList);
    const tableX = 40;
    const pageCenter = doc.page.width / 2;

    // ==================== HEADER ====================
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor("#008080")
      .text("PEMERINTAH KOTA PALANGKA RAYA", { align: "center" });

    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#1a3a4a")
      .text(`DINAS PENDIDIKAN - ${data.sekolah.nama || "SD NEGERI"}`, {
        align: "center",
      });

    doc
      .font("Helvetica-Oblique")
      .fontSize(9)
      .fillColor("#008080")
      .text(`Alamat: ${data.sekolah.alamat || "-"}`, { align: "center" });

    doc.moveDown(0.3);

    // Garis pemisah header
    doc
      .strokeColor("#1a3a4a")
      .lineWidth(1.5)
      .moveTo(tableX, doc.y)
      .lineTo(doc.page.width - 40, doc.y)
      .stroke();

    doc.moveDown(0.6);

    // ==================== JUDUL LAPORAN ====================
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor("#008080")
      .text("LAPORAN HASIL PETUALANGAN BELAJAR (IPAS)", { align: "center" });

    const semesterText = data.sekolah.semester === "genap" ? "Genap" : "Ganjil";
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("black")
      .text(
        `Semester ${semesterText} - Tahun Ajaran ${data.sekolah.tahun_ajaran || "-"}`,
        { align: "center" },
      );

    doc.moveDown(1);

    // ==================== INFO PESERTA DIDIK ====================
    const infoStartY = doc.y;
    const labelWidth = 95;
    const col1X = tableX;
    const col1ValueX = col1X + labelWidth;
    const col2X = pageCenter + 20;
    const col2ValueX = col2X + 85;

    // Row 1
    doc.font("Helvetica-Bold").fontSize(10).fillColor("black");
    doc.text("Nama Petualang", col1X, infoStartY);
    doc
      .font("Helvetica")
      .text(
        `: ${data.pesertaDidik.nama_lengkap || "-"}`,
        col1ValueX,
        infoStartY,
      );

    doc.font("Helvetica-Bold").text("Kelas / Fase", col2X, infoStartY);
    doc
      .font("Helvetica")
      .text(`: ${data.kelas.nama || "-"}`, col2ValueX, infoStartY);

    // Row 2
    const row2Y = infoStartY + 16;
    doc.font("Helvetica-Bold").text("NISN", col1X, row2Y);
    doc
      .font("Helvetica")
      .text(`: ${data.pesertaDidik.nisn || "-"}`, col1ValueX, row2Y);

    doc.font("Helvetica-Bold").text("Tanggal Cetak", col2X, row2Y);
    doc
      .font("Helvetica")
      .text(`: ${formatDate(data.tanggalCetak)}`, col2ValueX, row2Y);

    doc.y = row2Y + 28;

    // ==================== SUMMARY BOXES ====================
    const boxY = doc.y;
    const boxHeight = 50;
    const boxGap = 15;
    const totalBoxWidth = pageWidth - boxGap * 2;
    const boxWidth = totalBoxWidth / 3;

    // Box 1 - Progress Peta
    const box1X = tableX;
    doc
      .roundedRect(box1X, boxY, boxWidth, boxHeight, 4)
      .lineWidth(1)
      .stroke("#d0d0d0");
    doc
      .font("Helvetica-Bold")
      .fontSize(20)
      .fillColor("#008080")
      .text(`${stats.progressPeta}%`, box1X, boxY + 10, {
        width: boxWidth,
        align: "center",
      });
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#666666")
      .text("Progress Peta", box1X, boxY + 35, {
        width: boxWidth,
        align: "center",
      });

    // Box 2 - Bintang Terkumpul
    const box2X = box1X + boxWidth + boxGap;
    doc
      .roundedRect(box2X, boxY, boxWidth, boxHeight, 4)
      .lineWidth(1)
      .stroke("#d0d0d0");
    doc
      .font("Helvetica-Bold")
      .fontSize(20)
      .fillColor("#008080")
      .text(
        `${stats.bintangTerkumpul}/${stats.totalBintang}`,
        box2X,
        boxY + 10,
        { width: boxWidth, align: "center" },
      );
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#666666")
      .text("Bintang Terkumpul", box2X, boxY + 35, {
        width: boxWidth,
        align: "center",
      });

    // Box 3 - Predikat Petualang
    const box3X = box2X + boxWidth + boxGap;
    doc
      .roundedRect(box3X, boxY, boxWidth, boxHeight, 4)
      .lineWidth(1)
      .stroke("#d0d0d0");
    const predikatColor =
      stats.predikatPetualang === "SANGAT BAIK"
        ? "#28a745"
        : stats.predikatPetualang === "BAIK"
          ? "#17a2b8"
          : stats.predikatPetualang === "CUKUP"
            ? "#ffc107"
            : "#dc3545";
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(predikatColor)
      .text(stats.predikatPetualang, box3X, boxY + 12, {
        width: boxWidth,
        align: "center",
      });
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#666666")
      .text("Predikat Petualang", box3X, boxY + 35, {
        width: boxWidth,
        align: "center",
      });

    doc.y = boxY + boxHeight + 15;

    // ==================== TABLE ====================
    // Column widths - adjusted to fit page
    const colWidths = {
      no: 30,
      misi: pageWidth - 30 - 60 - 50 - 60, // remaining space for misi
      status: 60,
      nilai: 50,
      predikat: 60,
    };

    const drawTableHeader = (y: number): number => {
      // Header background
      doc.rect(tableX, y, pageWidth, 20).fill("#1a3a4a");

      // Header text
      doc.font("Helvetica-Bold").fontSize(8).fillColor("white");

      let xPos = tableX;
      doc.text("No", xPos, y + 6, { width: colWidths.no, align: "center" });

      xPos += colWidths.no;
      doc.text("Misi Petualangan (Materi IPAS)", xPos, y + 6, {
        width: colWidths.misi,
        align: "center",
      });

      xPos += colWidths.misi;
      doc.text("Status", xPos, y + 6, {
        width: colWidths.status,
        align: "center",
      });

      xPos += colWidths.status;
      doc.text("Nilai", xPos, y + 6, {
        width: colWidths.nilai,
        align: "center",
      });

      xPos += colWidths.nilai;
      doc.text("Predikat", xPos, y + 6, {
        width: colWidths.predikat,
        align: "center",
      });

      return y + 20;
    };

    let currentY = drawTableHeader(doc.y);

    // Table rows
    data.babList.forEach((bab, babIndex) => {
      // Check if we need a new page for bab row
      if (currentY > doc.page.height - 100) {
        doc.addPage();
        currentY = drawTableHeader(40);
      }

      const babNilai = calculateBabNilai(bab.topik);
      const babStatus = getStatus(bab.topik);
      const babPredikat = getPredikat(babNilai);

      // Bab row (with background)
      const babRowHeight = 22;
      doc.rect(tableX, currentY, pageWidth, babRowHeight).fill("#f5f5f5");
      doc
        .rect(tableX, currentY, pageWidth, babRowHeight)
        .lineWidth(0.5)
        .stroke("#e0e0e0");

      doc.font("Helvetica-Bold").fontSize(8).fillColor("#1a3a4a");

      let xPos = tableX;
      doc.text(`${babIndex + 1}`, xPos, currentY + 7, {
        width: colWidths.no,
        align: "center",
      });

      xPos += colWidths.no;
      const babTitle = `BAB ${bab.nomor}: ${(bab.judul || "").toUpperCase()}`;
      doc.text(babTitle, xPos + 3, currentY + 7, {
        width: colWidths.misi - 6,
        lineBreak: false,
      });

      xPos += colWidths.misi;
      const statusColor =
        babStatus === "LULUS"
          ? "#28a745"
          : babStatus === "PROSES"
            ? "#fd7e14"
            : "#6c757d";
      doc.fillColor(statusColor).text(babStatus, xPos, currentY + 7, {
        width: colWidths.status,
        align: "center",
      });

      xPos += colWidths.status;
      doc
        .fillColor("#1a3a4a")
        .text(
          babNilai !== null ? babNilai.toString() : "-",
          xPos,
          currentY + 7,
          { width: colWidths.nilai, align: "center" },
        );

      xPos += colWidths.nilai;
      doc.text(babPredikat, xPos, currentY + 7, {
        width: colWidths.predikat,
        align: "center",
      });

      currentY += babRowHeight;

      // Topik rows
      bab.topik.forEach((topik) => {
        if (currentY > doc.page.height - 60) {
          doc.addPage();
          currentY = drawTableHeader(40);
        }

        const topikNilai = topik.nilai_quiz?.nilai;
        const topikPredikat = getPredikat(topikNilai ?? null);
        const topikRowHeight = 18;

        // Row border
        doc
          .rect(tableX, currentY, pageWidth, topikRowHeight)
          .lineWidth(0.5)
          .stroke("#e0e0e0");

        doc.font("Helvetica").fontSize(8).fillColor("#444444");

        let xPos = tableX;
        // Empty No column for topik
        xPos += colWidths.no;

        // Topik text with proper truncation
        const topikText = `Topik ${topik.kode}: ${topik.judul || ""}`;
        doc.text(topikText, xPos + 8, currentY + 5, {
          width: colWidths.misi - 12,
          lineBreak: false,
          ellipsis: true,
        });

        xPos += colWidths.misi;
        // Empty status for topik
        xPos += colWidths.status;

        doc.text(
          topikNilai !== null && topikNilai !== undefined
            ? topikNilai.toString()
            : "-",
          xPos,
          currentY + 5,
          { width: colWidths.nilai, align: "center" },
        );

        xPos += colWidths.nilai;
        doc.text(topikPredikat, xPos, currentY + 5, {
          width: colWidths.predikat,
          align: "center",
        });

        currentY += topikRowHeight;
      });
    });

    // ==================== SIGNATURE SECTION ====================
    currentY += 35;

    // Check if we need a new page for signature
    if (currentY > doc.page.height - 120) {
      doc.addPage();
      currentY = 60;
    }

    const sigY = currentY;
    const sigWidth = 180;
    const leftSigCenterX = tableX + pageWidth / 4;
    const rightSigCenterX = tableX + (pageWidth * 3) / 4;

    doc.font("Helvetica").fontSize(10).fillColor("black");

    // Left signature - Orang Tua/Wali
    doc.text("Mengetahui,", leftSigCenterX - sigWidth / 2, sigY, {
      width: sigWidth,
      align: "center",
    });
    doc.text("Orang Tua/Wali", leftSigCenterX - sigWidth / 2, sigY + 14, {
      width: sigWidth,
      align: "center",
    });
    doc.text(
      "( ........................................ )",
      leftSigCenterX - sigWidth / 2,
      sigY + 65,
      { width: sigWidth, align: "center" },
    );

    // Right signature - Guru
    doc.text(
      `Palangka Raya, ${formatDate(data.tanggalCetak)}`,
      rightSigCenterX - sigWidth / 2,
      sigY,
      { width: sigWidth, align: "center" },
    );
    doc.text(
      `Guru Kelas ${data.kelas.nama || ""}`,
      rightSigCenterX - sigWidth / 2,
      sigY + 14,
      { width: sigWidth, align: "center" },
    );

    // Guru name and NIP - centered
    const guruName = data.guru?.nama_lengkap || "                  ";
    const guruNip =
      data.guru?.nip || "........................................";

    doc.font("Helvetica-Bold").fillColor("#008080");
    doc.text(`( ${guruName} )`, rightSigCenterX - sigWidth / 2, sigY + 65, {
      width: sigWidth,
      align: "center",
    });

    doc.font("Helvetica").fillColor("black").fontSize(9);
    doc.text(`NIP. ${guruNip}`, rightSigCenterX - sigWidth / 2, sigY + 78, {
      width: sigWidth,
      align: "center",
    });

    doc.end();
  });
}

function formatDate(date: Date): string {
  const months = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}
