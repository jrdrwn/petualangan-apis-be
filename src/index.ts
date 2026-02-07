import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { except } from 'hono/combine'
import { cors } from 'hono/cors'
import type { JwtVariables } from 'hono/jwt'
import { jwt, sign } from 'hono/jwt'
import { logger } from 'hono/logger'
import { z } from 'zod'
import type { PrismaClient } from './generated/prisma/client.js'
import { generateLaporanPdf } from './lib/generateLaporanPdf.js'
import withPrisma from './lib/prisma.js'

type ContextWithPrisma = {
  Variables: {
    prisma: PrismaClient
    jwt: JwtVariables
  }
}

const app = new Hono<ContextWithPrisma>()

// Logger middleware
app.use('*', logger())

// app.use('/*', cors({
//   origin: ['http://localhost:*', 'http://127.0.0.1:*'],
//   allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
//   allowHeaders: ['Content-Type', 'Authorization'],
//   credentials: true,
// }))

// Tambahkan sebelum routes
app.use(
  cors({
    origin: '*', // atau 'http://localhost:xxxx' sesuai port flutter web
    credentials: true,
  }),
)

app.use(
  '/*',
  except(
    ['/peserta-didik/login', '/peserta-didik/register', '/sekolah', '/:sekolah_id/kelas', '/guru/login', '/guru/register'],
    jwt({
      secret: 'your-secret-key',
      alg: 'HS256',
    }),
  ),
)

app.get('/', withPrisma, async (c) => {
  const prisma = c.get('prisma')

  return c.text('Hello Hono!')
})

app.get('/sekolah', withPrisma, async (c) => {
  const prisma = c.get('prisma')

  const sekolah = await prisma.sekolah.findMany()

  return c.json(sekolah)
})

app.get(
  '/:sekolah_id/kelas',
  zValidator(
    'param',
    z.object({
      sekolah_id: z.coerce.number().int().positive(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const { sekolah_id } = c.req.valid('param')

    const kelas = await prisma.kelas.findMany({
      where: {
        sekolah_id,
      },
    })

    return c.json(kelas)
  },
)

app.post(
  '/peserta-didik/register',
  zValidator(
    'json',
    z.object({
      nama: z.string().min(1),
      nisn: z.string().min(1),
      kelas_id: z.number().int().positive(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const { nama, nisn, kelas_id } = c.req.valid('json')

    const pesertaDidik = await prisma.peserta_didik.create({
      data: {
        nama_lengkap: nama,
        nisn,
        kelas_id,
      },
    })

    return c.json(pesertaDidik)
  },
)

app.post(
  '/peserta-didik/login',
  zValidator(
    'json',
    z.object({
      nisn: z.string().min(1),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const { nisn } = c.req.valid('json')

    const pesertaDidik = await prisma.peserta_didik.findUnique({
      where: {
        nisn,
      },
    })

    if (!pesertaDidik) {
      return c.json({ error: 'Invalid NISN' }, 401)
    }

    const token = await sign(
      {
        sub: pesertaDidik.id,
      },
      'your-secret-key',
    )

    return c.json({ token, peserta_didik: pesertaDidik })
  },
)

app.put(
  '/peserta-didik/profile',
  zValidator(
    'json',
    z.object({
      nama_lengkap: z.string().min(1).optional(),
      nisn: z.string().min(1).optional(),
      kelas_id: z.number().int().positive().optional(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const peserta_didik_id = c.get('jwtPayload').sub as number
    const { nama_lengkap, nisn, kelas_id } = c.req.valid('json')

    const pesertaDidik = await prisma.peserta_didik.update({
      where: {
        id: peserta_didik_id,
      },
      data: {
        nama_lengkap,
        nisn,
        kelas_id,
      },
    })

    return c.json(pesertaDidik)
  },
)

app.delete('/peserta-didik/profile', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const peserta_didik_id = c.get('jwtPayload').sub as number

  await prisma.peserta_didik.delete({
    where: {
      id: peserta_didik_id,
    },
  })

  return c.json({ message: 'Peserta didik deleted successfully' })
})

app.delete('/peserta-didik/reset', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const peserta_didik_id = c.get('jwtPayload').sub as number

  // Hapus semua nilai_quiz peserta didik
  await prisma.nilai_quiz.deleteMany({
    where: {
      peserta_didik_id,
    },
  })

  return c.json({ message: 'Progress reset successfully' })
})

app.get('/bab/topik', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const peserta_didik_id = c.get('jwtPayload').sub as number

  const pesertaDidik = await prisma.peserta_didik.findUnique({
    where: {
      id: peserta_didik_id,
    },
  })

  if (!pesertaDidik) {
    return c.json({ error: 'Peserta didik not found' }, 404)
  }

  const babList = await prisma.bab.findMany({
    where: {
      kelas_id: pesertaDidik.kelas_id,
    },
  })

  const topikList = await prisma.topik.findMany({
    where: {
      bab: {
        OR: babList.map((bab) => ({ id: bab.id })),
      },
    },
  })

  const nilaiQuizList = await prisma.nilai_quiz.findMany({
    where: {
      peserta_didik_id,
      topik: {
        OR: topikList.map((topik) => ({ id: topik.id })),
      },
    },
  })

  // Sort babList by id to ensure order
  babList.sort((a, b) => a.id - b.id)

  babList.forEach((bab, babIdx) => {
    // Sort topik in each bab by kode (assuming kode is like 'A', 'B', ...)
    const topikInBab = topikList.filter((topik) => topik.bab_id === bab.id).sort((a, b) => a!.kode!.localeCompare(b!.kode!))

    let unlocked = false

    // Bab pertama dan topik pertama pasti terbuka
    if (babIdx === 0) {
      unlocked = true
    } else {
      // Cek apakah semua topik pada bab sebelumnya sudah selesai (ada nilaiQuiz)
      const prevBab = babList[babIdx - 1]
      const prevTopik = topikList.filter((topik) => topik.bab_id === prevBab.id)
      const allPrevTopikSelesai = prevTopik.every((topik) => nilaiQuizList.some((nilai) => nilai.topik_id === topik.id))
      unlocked = allPrevTopikSelesai
    }

    let prevTopikUnlocked = unlocked

    Object.assign(bab, {
      topik: topikInBab.map((topik, topikIdx) => {
        const nilaiQuiz = nilaiQuizList.find((nilai) => nilai.topik_id === topik.id)
        let isUnlocked = false

        if (babIdx === 0 && topikIdx === 0) {
          // Topik pertama bab pertama selalu terbuka
          isUnlocked = true
        } else if (topikIdx === 0) {
          // Topik pertama bab selain bab pertama, unlocked jika bab sudah unlocked
          isUnlocked = unlocked
        } else {
          // Topik berikutnya unlocked jika topik sebelumnya sudah selesai
          const prevTopik = topikInBab[topikIdx - 1]
          const prevTopikSelesai = nilaiQuizList.some((nilai) => nilai.topik_id === prevTopik.id)
          isUnlocked = prevTopikSelesai
        }

        return {
          ...topik,
          unlocked: isUnlocked,
        }
      }),
    })
  })

  return c.json(babList)
})

app.get(
  '/quiz/:topik_id',
  zValidator(
    'param',
    z.object({
      topik_id: z.coerce.number().int().positive(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const peserta_didik_id = c.get('jwtPayload').sub as number
    const { topik_id } = c.req.valid('param')

    // Ambil topik yang diminta
    const topik = await prisma.topik.findUnique({
      where: { id: topik_id },
    })
    if (!topik) {
      return c.json({ error: 'Topik not found' }, 404)
    }

    // Ambil bab dari topik
    const bab = await prisma.bab.findUnique({
      where: { id: topik.bab_id! },
    })
    if (!bab) {
      return c.json({ error: 'Bab not found' }, 404)
    }

    // Ambil semua bab di kelas yang sama, urutkan
    const babList = await prisma.bab.findMany({
      where: { kelas_id: bab.kelas_id },
      orderBy: { id: 'asc' },
    })

    // Ambil semua topik di semua bab tersebut
    const topikList = await prisma.topik.findMany({
      where: {
        bab: {
          OR: babList.map((b) => ({ id: b.id })),
        },
      },
    })

    // Ambil semua nilai quiz peserta didik untuk topik-topik tersebut
    const nilaiQuizList = await prisma.nilai_quiz.findMany({
      where: {
        peserta_didik_id,
        topik: {
          OR: topikList.map((t) => ({ id: t.id })),
        },
      },
    })

    // Cek unlocked status untuk topik yang diminta
    // Mirip logika di endpoint /bab/topik
    let isUnlocked = false
    let found = false

    // Sort babList by id
    babList.sort((a, b) => a.id - b.id)

    for (let babIdx = 0; babIdx < babList.length; babIdx++) {
      const babItem = babList[babIdx]
      // Sort topik in each bab by kode
      const topikInBab = topikList.filter((t) => t.bab_id === babItem.id).sort((a, b) => a!.kode!.localeCompare(b!.kode!))

      let unlocked = false
      if (babIdx === 0) {
        unlocked = true
      } else {
        const prevBab = babList[babIdx - 1]
        const prevTopik = topikList.filter((t) => t.bab_id === prevBab.id)
        const allPrevTopikSelesai = prevTopik.every((t) => nilaiQuizList.some((nilai) => nilai.topik_id === t.id))
        unlocked = allPrevTopikSelesai
      }

      for (let topikIdx = 0; topikIdx < topikInBab.length; topikIdx++) {
        const t = topikInBab[topikIdx]
        let unlockedTopik = false
        if (babIdx === 0 && topikIdx === 0) {
          unlockedTopik = true
        } else if (topikIdx === 0) {
          unlockedTopik = unlocked
        } else {
          const prevTopik = topikInBab[topikIdx - 1]
          const prevTopikSelesai = nilaiQuizList.some((nilai) => nilai.topik_id === prevTopik.id)
          unlockedTopik = prevTopikSelesai
        }

        if (t.id === topik_id) {
          isUnlocked = unlockedTopik
          found = true
          break
        }
      }
      if (found) break
    }

    if (!isUnlocked) {
      return c.json({ error: 'Topik belum terbuka/unlocked' }, 403)
    }

    const quizList = await prisma.quiz.findMany({
      where: {
        topik_id,
      },
    })

    return c.json(quizList)
  },
)

app.post(
  '/quiz/:topik_id/submit',
  zValidator(
    'param',
    z.object({
      topik_id: z.coerce.number().int().positive(),
    }),
  ),
  withPrisma,
  zValidator(
    'json',
    z.object({
      hasil_quiz: z.array(
        z.object({
          quiz_id: z.number().int().positive(),
          jawaban: z.string(),
        }),
      ),
    }),
  ),
  async (c) => {
    const prisma = c.get('prisma')
    const peserta_didik_id = c.get('jwtPayload').sub as number
    const { topik_id } = c.req.valid('param')
    const { hasil_quiz } = c.req.valid('json')

    // Cek apakah topik ada
    const topik = await prisma.topik.findUnique({
      where: { id: topik_id },
    })
    if (!topik) {
      return c.json({ error: 'Topik not found' }, 404)
    }
    // Cek apakah quiz-quiz tersebut ada dan sesuai dengan topik
    const quizList = await prisma.quiz.findMany({
      where: {
        id: { in: hasil_quiz.map((h) => h.quiz_id) },
        topik_id,
      },
    })
    if (quizList.length !== hasil_quiz.length) {
      return c.json({ error: 'Some quiz not found or do not belong to the topik' }, 404)
    }

    // Hitung skor
    // let skor = 0
    // hasil_quiz.forEach((h) => {
    //   const quiz = quizList.find((q) => q.id === h.quiz_id)!
    //   if (quiz.jawaban === h.jawaban) {
    //     skor += 1
    //   }
    // })

    // Simpan atau perbarui nilai_quiz
    // const existingNilaiQuiz = await prisma.nilai_quiz.findFirst({
    //   where: {
    //     peserta_didik_id,
    //     topik_id,
    //   },
    // })

    // if (existingNilaiQuiz) {
    //   await prisma.nilai_quiz.update({
    //     where: { id: existingNilaiQuiz.id },
    //     data: {
    //       hasil_quiz: JSON.stringify(hasil_quiz),
    //      },
    //   })
    // } else {
    await prisma.nilai_quiz.create({
      data: {
        peserta_didik_id,
        topik_id,
        hasil_quiz: JSON.stringify(hasil_quiz),
        tanggal_selesai: new Date(),
      },
    })
    // }

    return c.json({ message: 'Quiz submitted successfully' })
  },
)

// register guru
app.post(
  '/guru/register',
  zValidator(
    'json',
    z.object({
      nama_lengkap: z.string().min(1),
      nip: z.string().min(1),
      password: z.string().min(1),
      sekolah_id: z.number().int().positive(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const { nama_lengkap, nip, password, sekolah_id } = c.req.valid('json')

    const existingGuru = await prisma.guru.findUnique({
      where: {
        nip,
      },
    })
    if (existingGuru) {
      return c.json({ error: 'NIP already registered' }, 400)
    }

    const guru = await prisma.guru.create({
      data: {
        nama_lengkap,
        nip,
        password,
        sekolah_id,
      },
    })

    return c.json(guru)
  },
)

app.put(
  '/guru/profile',
  zValidator(
    'json',
    z.object({
      nama_lengkap: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
      sekolah_id: z.number().int().positive().optional(),
      email: z.email().optional(),
      no_telepon: z.string().optional(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const guru_id = c.get('jwtPayload').sub as number
    const { nama_lengkap, password, sekolah_id, email, no_telepon } = c.req.valid('json')

    const guru = await prisma.guru.update({
      where: {
        id: guru_id,
      },
      data: {
        nama_lengkap,
        password,
        sekolah_id,
        email,
        no_telepon,
      },
    })

    return c.json(guru)
  },
)

app.delete('/guru/profile', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const guru_id = c.get('jwtPayload').sub as number

  await prisma.guru.delete({
    where: {
      id: guru_id,
    },
  })

  return c.json({ message: 'Guru deleted successfully' })
})

// login guru
// nip, password, sekolah_id
app.post(
  '/guru/login',
  zValidator(
    'json',
    z.object({
      nip: z.string().min(1),
      password: z.string().min(1),
      sekolah_id: z.number().int().positive(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const { nip, password, sekolah_id } = c.req.valid('json')

    const guru = await prisma.guru.findUnique({
      where: {
        nip,
      },
    })

    if (!guru || guru.password !== password || guru.sekolah_id !== sekolah_id) {
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    const token = await sign(
      {
        sub: guru.id,
      },
      'your-secret-key',
    )

    return c.json({ token, guru })
  },
)

// get peserta didik by kelas id
app.get(
  '/guru/peserta-didik/kelas/:kelas_id',
  zValidator(
    'param',
    z.object({
      kelas_id: z.coerce.number().int().positive(),
    }),
  ),
  zValidator(
    'query',
    z.object({
      limit: z.coerce.number().int().positive().optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const { kelas_id } = c.req.valid('param')
    const { limit = 20, offset = 0 } = c.req.valid('query')

    const pesertaDidikList = await prisma.peserta_didik.findMany({
      where: {
        kelas_id,
      },
      take: limit,
      skip: offset,
    })

    return c.json(pesertaDidikList)
  },
)

app.get(
  '/guru/peserta-didik/:peserta_didik_id/nilai',
  zValidator(
    'param',
    z.object({
      peserta_didik_id: z.coerce.number().int().positive(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const { peserta_didik_id } = c.req.valid('param')

    const pesertaDidik = await prisma.peserta_didik.findUnique({
      where: {
        id: peserta_didik_id,
      },
    })

    if (!pesertaDidik) {
      return c.json({ error: 'Peserta didik not found' }, 404)
    }

    const babList = await prisma.bab.findMany({
      where: {
        kelas_id: pesertaDidik.kelas_id,
      },
    })

    const topikList = await prisma.topik.findMany({
      where: {
        bab: {
          OR: babList.map((bab) => ({ id: bab.id })),
        },
      },
    })

    // Ambil semua nilai_quiz untuk peserta_didik dan topik-topik terkait (bisa lebih dari satu per topik)
    const nilaiQuizList = await prisma.nilai_quiz.findMany({
      where: {
        peserta_didik_id,
        topik: {
          OR: topikList.map((topik) => ({ id: topik.id })),
        },
      },
      orderBy: {
        tanggal_selesai: 'desc',
      },
    })

    // Ambil semua quiz untuk topik-topik yang ada
    const quizList = await prisma.quiz.findMany({
      where: {
        topik_id: {
          in: topikList.map((topik) => topik.id),
        },
      },
    })

    // Untuk setiap topik, ambil nilai_quiz dengan nilai tertinggi
    const topikIdToBestNilaiQuiz: Record<number, { nilaiQuiz: any; nilai: number | null }> = {}

    topikList.forEach((topik) => {
      // Filter semua percobaan untuk topik ini
      const percobaan = nilaiQuizList.filter((nilai) => nilai.topik_id === topik.id)
      let bestNilaiQuiz = null
      let bestNilai: number | null = null

      percobaan.forEach((nilaiQuiz) => {
        let nilai = null
        if (nilaiQuiz && nilaiQuiz.hasil_quiz) {
          try {
            const hasilQuizArr: Array<{ quiz_id: number; jawaban: string }> = JSON.parse(nilaiQuiz.hasil_quiz.toString())
            let benar = 0
            let total = hasilQuizArr.length

            hasilQuizArr.forEach((jawabanObj) => {
              const quiz = quizList.find((q) => q.id === jawabanObj.quiz_id)
              if (quiz && quiz.jawaban === jawabanObj.jawaban) {
                benar += 1
              }
            })

            nilai = total > 0 ? Math.round((benar / total) * 100) : null
          } catch (e) {
            nilai = null
          }
        }
        if (bestNilai === null || (nilai !== null && nilai > bestNilai)) {
          bestNilaiQuiz = nilaiQuiz
          bestNilai = nilai
        }
      })

      if (bestNilaiQuiz) {
        topikIdToBestNilaiQuiz[topik.id] = {
          nilaiQuiz: bestNilaiQuiz,
          nilai: bestNilai,
        }
      }
    })

    // Sort babList by id to ensure order
    babList.sort((a, b) => a.id - b.id)

    babList.forEach((bab) => {
      // Sort topik in each bab by kode (assuming kode is like 'A', 'B', ...)
      const topikInBab = topikList.filter((topik) => topik.bab_id === bab.id).sort((a, b) => a!.kode!.localeCompare(b!.kode!))

      Object.assign(bab, {
        topik: topikInBab.map((topik) => {
          const best = topikIdToBestNilaiQuiz[topik.id]
          return {
            ...topik,
            nilai_quiz: best
              ? {
                  ...best.nilaiQuiz,
                  nilai: best.nilai,
                }
              : null,
          }
        }),
      })
    })

    return c.json(babList)
  },
)

// Generate PDF untuk peserta didik sendiri (tanpa auth guru)
app.get('/peserta-didik/laporan-pdf', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const pesertaDidikId = c.get('jwtPayload').sub as number

  try {
    const pdfBuffer = await generateLaporanPdf(prisma, pesertaDidikId)

    const pesertaDidik = await prisma.peserta_didik.findUnique({
      where: { id: pesertaDidikId },
    })

    const filename = `Laporan_${pesertaDidik?.nama_lengkap?.replace(/\s+/g, '_') || 'Peserta_Didik'}_${Date.now()}.pdf`

    // Convert Buffer to Uint8Array for Response compatibility
    const uint8Array = new Uint8Array(pdfBuffer)

    return new Response(uint8Array, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return c.json({ error: errorMessage }, 500)
  }
})

app.get(
  '/guru/laporan-pdf/:peserta_didik_id',
  zValidator(
    'param',
    z.object({
      peserta_didik_id: z.coerce.number().int().positive(),
    }),
  ),
  withPrisma,
  async (c) => {
    const prisma = c.get('prisma')
    const { peserta_didik_id } = c.req.valid('param')
    const guru_id = c.get('jwtPayload').sub as number

    try {
      const pdfBuffer = await generateLaporanPdf(prisma, peserta_didik_id, guru_id)

      // Get peserta didik name for filename
      const pesertaDidik = await prisma.peserta_didik.findUnique({
        where: { id: peserta_didik_id },
      })

      if (!pesertaDidik) {
        return c.json({ error: 'Peserta didik tidak ditemukan' }, 404)
      }

      const filename = `Laporan_${pesertaDidik.nama_lengkap?.replace(/\s+/g, '_') || 'Peserta_Didik'}_${Date.now()}.pdf`

      // Convert Buffer to Uint8Array for Response compatibility
      const uint8Array = new Uint8Array(pdfBuffer)

      return new Response(uint8Array, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return c.json({ error: errorMessage }, 500)
    }
  },
)

// Generate PDF Laporan untuk testing (tanpa auth) - khusus guru

serve(
  {
    fetch: app.fetch,
    port: 3000,
    hostname: '0.0.0.0',
  },
  (info) => {
    console.log(`Server is running on http://0.0.0.0:${info.port}`)
  },
)
