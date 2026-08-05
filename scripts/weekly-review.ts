import 'dotenv/config';
import { getWeeklyDigest } from '../lib/weekly-stats';

const digest = getWeeklyDigest();

console.log(JSON.stringify(digest));
