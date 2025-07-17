import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;


app.use(express.json())
app.use(cors())
app.use(morgan('combined'))

app.listen(PORT, () => {
  console.log(`App run on port ${PORT}`);
});
