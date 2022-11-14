// KMA PARAMETER
const Nvar = 3 // dimension
const MLIPIR_RATE = (Nvar - 1) / Nvar * 1.0
const ALPHA = 0.5
const ALPHA_RADIUS = 0.1
const PORTION = 0.5
const MAX_GEN = 200
const MAX_IMPROVEMENT = 30
const MAX_GEN_IMPROVE = 3
const MAX_GEN_STAGNAN = 6
const OPTIMUM_X = 10
const OPTIMUM_Y = 10
const OPTIMUM_Z = 10
const OPTIMUM_FITNESS = 300
const OPTIMUM_RADIUS = 0.07
const OFFSET = 10
// max dari x y z / upperbound
const Ra = {
    'x' : 10, 
    'y' : 10, 
    'z' : 10
}
// min dari x y z / lowerbound
const Rb = {
    'x' : 0, 
    'y' : 0, 
    'z' : 0
}


// KMA
function KMA (journals, initPop, minPop, maxPop, initIncDecAdaPop, crawlerOpt) {
    // initialize
    let komodos = []
    let bestKomodo = []
    let newGenKomodos = []
    let gen = 1
    let genImprove = 0
    let totalGenImprove = 0
    let genStagnan = 0
    let adaPopSize = initPop
    
    // initialize population / first gen
    // 1 komodo = 1 journal
    for (let i = 0; i < journals.length; i++) {
        // menentukan value1, value2, dan value3
        if (crawlerOpt === 3) {
            // acd
            journals[i].value1 = ((journals[i].abstractVal * 0.9) + (journals[i].referencesVal * 0.1)) * OFFSET
            journals[i].value2 = journals[i].fullTextVal * OFFSET
            journals[i].value3 = ((journals[i].keywordsVal * 0.4) + (journals[i].citedVal * 0.6)) * OFFSET
        } else {
            // scd & ieee & sage
            journals[i].value1 = ((journals[i].abstractVal * 0.9) + (journals[i].referencesVal * 0.1)) * OFFSET
            journals[i].value2 = journals[i].fullTextVal * OFFSET
            journals[i].value3 = ((journals[i].citedVal * 0.4) + (journals[i].keywordsVal * 0.6)) * OFFSET
        }

        // push
        komodos.push({
            'journal' : journals[i],
            'id': journals[i].g_id,
            'fitness' : f(journals[i].value1, journals[i].value2, journals[i].value3, journals[i].factor), 
            'x' : journals[i].value1, 
            'y' : journals[i].value2, 
            'z' : journals[i].value3
        })
    }

    let incDecAdaPopSize = initIncDecAdaPop

    rankKomodos(komodos)
    
    if (adaPopSize < 6) {
        return komodos
    }

    bestKomodo = komodos[0]

    while (!stoppingCriterion(gen, totalGenImprove)) {
        // console.log("=================================================================")
        // console.log("GEN : " + gen)
        // console.log("=================================================================")

        newGenKomodos = []
        let splitedKomodos = splitPopulation(komodos)
        
        largeKomodoBehavior(splitedKomodos.bigMales)
        femaleBehavior(splitedKomodos.female, bestQualityKomodos(splitedKomodos.bigMales))
        smallKomodoBehavior(splitedKomodos.smallMales, splitedKomodos.bigMales)

        for (let i = 0; i < splitedKomodos.bigMales.length; i++) {
            newGenKomodos.push(splitedKomodos.bigMales[i])
        }
        newGenKomodos.push(splitedKomodos.female)
        for (let i = 0; i < splitedKomodos.smallMales.length; i++) {
            newGenKomodos.push(splitedKomodos.smallMales[i])
        }

        // bestKomodo : i - 1 gen / past gen / old gen
        // newGenKomodos[0] : i gen / new gen
        //  SIDE NOTE lebih kecil karena semakin kecil semakin baik (paper, sesuai paper)
        if (bestQualityKomodos(newGenKomodos).fitness < bestKomodo.fitness) {
            genImprove++
            genStagnan = 0
            bestKomodo = newGenKomodos[0]
        } else {
            genImprove = 0
            genStagnan++
        }

        if (genImprove > MAX_GEN_IMPROVE) {
            // console.log("genimprove")
            adaPopSize -= incDecAdaPopSize
            if (adaPopSize < minPop) {
                adaPopSize = minPop
            }

            rankKomodos(newGenKomodos)

            // delete komodo yang paling bawah (worst fitness)
            newGenKomodos.length = adaPopSize

            // reset ctr
            genImprove = 0
            // increase totalGenImprove ctr
            totalGenImprove++
        } else if (genStagnan > MAX_GEN_STAGNAN) {
            // console.log("stagnan")
            // reposition
            for (let i = 0; i < newGenKomodos.length; i++) {
                reposition(newGenKomodos[i])
            }

            rankKomodos(newGenKomodos)

            // reset ctr
            genStagnan = 0
        }

        // replace old gen with new gen
        komodos = newGenKomodos

        // gen + 1
        gen++
    }

    return newGenKomodos
}

function stoppingCriterion (gen, totalGenImprove) {
    if (gen <= MAX_GEN && totalGenImprove < MAX_IMPROVEMENT) {
        return false
    }
    return true
}

// menghitung fitness, semakin KECIL dif semakin BAIK
// f function, (n = 3 dimensi), fitness function -> selisih optimum fitness dengan fitness komodo
function f (x, y, z, factor) {
    const xdif = OPTIMUM_X - (x * factor)
    const ydif = OPTIMUM_Y - (y * factor)
    const zdif = OPTIMUM_Z - (z * factor)
    return (xdif * xdif) + (ydif * ydif) + (zdif * zdif)
}

// rank / sort dari quality tertinggi ke rendah
function rankKomodos (komodos) {
    // sort ascending (paper)
    // quality tertinggi = selisih dengan optimum yang terendah, mendekati 0 quality makin tinggi
    komodos.sort((a, b) => a.fitness > b.fitness ? 1 : -1)
}

// find best quality komodo
function bestQualityKomodos (komodos) {
    let bestKomodo = {
        'fitness': 999999
    }

    for (let i = 0; i < komodos.length; i++) {
        if (komodos[i].fitness < bestKomodo.fitness) {
            bestKomodo = komodos[i]
        }
    }

    return bestKomodo
}


// q big-q males (range from idx 0 - countBigMales(komodos.length))
// 1 mid-q female 
// s low-q males (range from idx countBigMales(komodos.length) + 1 - komodos.length)
function splitPopulation (komodos) {
    const splitKomodos = {
        'bigMales': [],
        'female': [],
        'smallMales': []
    }

    // big males
    for (let i = 0; i < countBigMales(komodos.length); i++) {
        splitKomodos.bigMales.push(komodos[i])
    }

    // female
    splitKomodos.female = komodos[countBigMales(komodos.length)]

    // small males
    for (let i = countBigMales(komodos.length) + 1; i < komodos.length; i++) {
        splitKomodos.smallMales.push(komodos[i])
    }

    return splitKomodos
}

function largeKomodoBehavior (bigMales) {
    for (let i = 0; i < bigMales.length; i++) {
        let maxFollow = Math.ceil(Math.random() * 2)
        let follow = 0
        let w = {
            'x' : 0, 
            'y' : 0, 
            'z' : 0
        }

        // sigma w
        for (let j = Math.floor(Math.random() * bigMales.length); j < bigMales.length && follow < maxFollow; j++) {
            if (j != i) {
                follow++
                let r1 = Math.random() * ALPHA
                // chance high quality do exploitation
                let r2 = Math.random() * ALPHA
                //  SIDE NOTE bisa jadi dokumentasi karena optimum adlaah 0 jadi kebalik (tdk sesuai paper)
                // karena fitness terdikit = fitness paling bagus, dan yang fix melakukan exploitation adalah komodo terburuk 
                if (f(bigMales[i].x, bigMales[i].y, bigMales[i].z, bigMales[i].journal.factor) < f(bigMales[j].x, bigMales[j].y, bigMales[j].z, bigMales[j].journal.factor) || r2 < 0.5) {
                    // ki - kj, exploration
                    w.x += r1 * (bigMales[i].x - bigMales[j].x)
                    w.y += r1 * (bigMales[i].y - bigMales[j].y)
                    w.z += r1 * (bigMales[i].z - bigMales[j].z)
                } else {
                    // kj - ki, exploitation
                    w.x += r1 * (bigMales[j].x - bigMales[i].x)
                    w.y += r1 * (bigMales[j].y - bigMales[i].y)
                    w.z += r1 * (bigMales[j].z - bigMales[i].z)
                }
            }
        }


        // ki', high quality - low quality both in exploi or explor
        bigMales[i].x += w.x
        bigMales[i].y += w.y
        bigMales[i].z += w.z  

        // mean, mencegah perubahan drastis dari quality asal
        bigMales[i].x = (bigMales[i].journal.value1 + bigMales[i].x) / 2
        bigMales[i].y = (bigMales[i].journal.value2 + bigMales[i].y) / 2
        bigMales[i].z = (bigMales[i].journal.value3 + bigMales[i].z) / 2
    
        // update fitness / evaluate quality
        bigMales[i].fitness = f(bigMales[i].x, bigMales[i].y, bigMales[i].z, bigMales[i].journal.factor) 
    }
}

function femaleBehavior (female, bigMale) {
    let rand = Math.random()
    if (bigMale.fitness < female.fitness && rand < 0.5) {
        // mate with big male (best quality male), if big male quality > female quality which is fitness < rendah
        let newOffspring1 = {
            'journal' : [],
            'x' : 0, 
            'y' : 0, 
            'z' : 0,
            'fitness': 0
        }
        let newOffspring2 = {
            'journal' : [],
            'x' : 0, 
            'y' : 0, 
            'z' : 0,
            'fitness': 0
        }

        // paper 
        rand = Math.random()
        newOffspring1.x = rand * bigMale.x + (1 - rand) * female.x
        rand = Math.random()
        newOffspring1.y = rand * bigMale.y + (1 - rand) * female.y
        rand = Math.random()
        newOffspring1.z = rand * bigMale.z + (1 - rand) * female.z
        
        // mean
        newOffspring1.x = (bigMale.journal.value1 + newOffspring1.x) / 2
        newOffspring1.y = (bigMale.journal.value2 + newOffspring1.y) / 2
        newOffspring1.z = (bigMale.journal.value3 + newOffspring1.z) / 2

        // update fitness / evaluate quality
        newOffspring1.fitness = f(newOffspring1.x, newOffspring1.y, newOffspring1.z, bigMale.journal.factor) 
    
        rand = Math.random()
        newOffspring2.x = rand * female.x + (1 - rand) * bigMale.x
        rand = Math.random()
        newOffspring2.y = rand * female.y + (1 - rand) * bigMale.y
        rand = Math.random()
        newOffspring2.z = rand * female.z + (1 - rand) * bigMale.z

        // mean
        newOffspring2.x = (female.journal.value1 + newOffspring2.x) / 2
        newOffspring2.y = (female.journal.value2 + newOffspring2.y) / 2
        newOffspring2.z = (female.journal.value3 + newOffspring2.z) / 2

        // update fitness / evaluate quality
        newOffspring2.fitness = f(newOffspring2.x, newOffspring2.y, newOffspring2.z, female.journal.factor) 

        // SIDE NOTE bisa jadi dokumentasi karena optimum adlaah 0 jadi kebalik (seauai paper)
        if (newOffspring1.fitness < newOffspring2.fitness) {
            if (newOffspring1.fitness < female.fitness) {
                newOffspring1.journal = female.journal
                female = newOffspring1
            }
        } else if (newOffspring2.fitness < female.fitness) {
            newOffspring2.journal = female.journal
            female = newOffspring2
        }
    } else {
        // parthenogenesis 
        let newFemale = {
            'journal' : female.journal,
            'x' : 0, 
            'y' : 0, 
            'z' : 0,
            'fitness': 0
        }

        rand = Math.random()
        if (rand < ALPHA) {
            rand = Math.random()
            newFemale.x = female.x + (2 * rand - 1) * ALPHA_RADIUS * (Math.abs(Ra.x - Rb.x))
        } 

        rand = Math.random()
        if (rand < ALPHA) {
            rand = Math.random()
            newFemale.y = female.y + (2 * rand - 1) * ALPHA_RADIUS * (Math.abs(Ra.y - Rb.y))
        } 

        rand = Math.random()
        if (rand < ALPHA) {
            rand = Math.random()
            newFemale.z = female.z + (2 * rand - 1) * ALPHA_RADIUS * (Math.abs(Ra.z - Rb.z))
        }

        // mean
        newFemale.x = (female.journal.value1 + newFemale.x) / 2
        newFemale.y = (female.journal.value2 + newFemale.y) / 2
        newFemale.z = (female.journal.value3 + newFemale.z) / 2

        // update fitness / evaluate quality
        newFemale.fitness = f(newFemale.x, newFemale.y, newFemale.z, female.journal.factor) 

        // SIDE NOTE bisa jadi dokumentasi karena optimum adlaah 0 jadi kebalik (seauai paper)
        if (newFemale.fitness < female.fitness) {
            female = newFemale
        }
    }
}

function smallKomodoBehavior (smallMales, bigMales) {
    for (let i = 0; i < smallMales.length; i++) {
        let maxFollow = Math.ceil(Math.random() * 3)
        let followBM = 0
        let r1 = Math.random()
        let r2 = Math.random()
        let w = {
            'x' : 0, 
            'y' : 0, 
            'z' : 0
        }

        // sigma w
        for (let j = Math.floor(Math.random() * bigMales.length); j < bigMales.length && followBM < maxFollow; j++) {
            followBM++
            r1 = Math.random()
            r2 = Math.random()
            if (r2 < MLIPIR_RATE){
                w.x += r1 * (bigMales[j].x - smallMales[i].x)
            }

            r1 = Math.random()
            r2 = Math.random()
            if (r2 < MLIPIR_RATE){
                w.y += r1 * (bigMales[j].y - smallMales[i].y)
            }

            r1 = Math.random()
            r2 = Math.random()
            if (r2 < MLIPIR_RATE){
                w.z += r1 * (bigMales[j].z - smallMales[i].z)
            }
        }

        // ki'
        smallMales[i].x += w.x
        smallMales[i].y += w.y
        smallMales[i].z += w.z

        // mean
        smallMales[i].x = (smallMales[i].journal.value1 + smallMales[i].x) / 2
        smallMales[i].y = (smallMales[i].journal.value2 + smallMales[i].y) / 2
        smallMales[i].z = (smallMales[i].journal.value3 + smallMales[i].z) / 2

        // update fitness / evaluate quality
        smallMales[i].fitness = f(smallMales[i].x, smallMales[i].y, smallMales[i].z, smallMales[i].journal.factor) 
    }
}

function reposition (komodo) {
    const temp = {
        'journal' : komodo.journal,
        'id': komodo.id,
        'fitness' : komodo.fitness, 
        'x' : komodo.x , 
        'y' : komodo.y , 
        'z' : komodo.z    
    }

    rand = Math.random()
    if (rand < ALPHA) {
        rand = Math.random()
        komodo.x = komodo.x + (2 * rand - 1) * ALPHA_RADIUS * ALPHA_RADIUS * (Math.abs(Ra.x - Rb.x))
    } 

    rand = Math.random()
    if (rand < ALPHA) {
        rand = Math.random()
        komodo.y = komodo.y + (2 * rand - 1) * ALPHA_RADIUS * ALPHA_RADIUS * (Math.abs(Ra.y - Rb.y))
    } 

    rand = Math.random()
    if (rand < ALPHA) {
        rand = Math.random()
        komodo.z = komodo.z + (2 * rand - 1) * ALPHA_RADIUS * ALPHA_RADIUS * (Math.abs(Ra.z - Rb.z))
    }
    
    // mean
    komodo.x = (komodo.journal.value1 + komodo.x) / 2
    komodo.y = (komodo.journal.value2 + komodo.y) / 2
    komodo.z = (komodo.journal.value3 + komodo.z) / 2

    // update fitness / evaluate quality
    komodo.fitness = f(komodo.x, komodo.y, komodo.z, komodo.journal.factor) 

    // if old better than new 
    if (temp.fitness < komodo.fitness) {
        // rollback
        komodo = temp
    } 
}


// determines how many big males, pop = total population
function countBigMales (pop) {
    return Math.floor(Math.abs(PORTION - 1) * pop * 1.0) >= Math.ceil(pop / 2 * 1.0) ? Math.ceil(pop / 2 * 1.0) : Math.floor(Math.abs(PORTION - 1) * pop * 1.0)
}

module.exports = {
    KMA: KMA,
};