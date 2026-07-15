const fs = require('fs');
const path = require('path');
const { ClassicLevel } = require('classic-level');
const config = require('../config.json');

async function getAllWorldData() {
    console.log("--- DaDAA: Starting Data Extraction ---");
    const worldDataPath = config.foundryDataPath;
    
    if (!fs.existsSync(worldDataPath)) {
        console.error(`ERROR: Path does not exist: ${worldDataPath}`);
        return {};
    }

    const categories = fs.readdirSync(worldDataPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    const worldData = {};

    for (const category of categories) {
        const categoryPath = path.join(worldDataPath, category);
        
        // Debug: Log which category we are checking
        console.log(`Checking category: ${category}`);

        if (fs.existsSync(path.join(categoryPath, 'CURRENT'))) {
            try {
                console.log(`  -> Found LevelDB database, opening...`);
                const db = new ClassicLevel(categoryPath, { valueEncoding: 'json' });
                const records = [];
                
                for await (const [key, value] of db.iterator()) {
                    records.push(value);
                }
                
                worldData[category] = records;
                console.log(`  -> Successfully loaded ${records.length} records.`);
                await db.close();
            } catch (err) {
                console.error(`  -> ERROR reading database at ${category}:`, err.message);
            }
        } else {
            console.log(`  -> Skipping (no LevelDB signature found).`);
        }
    }
    
    console.log("--- DaDAA: Extraction Complete ---");
    return worldData;
}

module.exports = { getAllWorldData };