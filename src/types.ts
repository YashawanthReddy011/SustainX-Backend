export type Role = "STUDENT" | "COMMUNITY" | "ADMIN";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  points: number;
}

export interface SDG {
  id: number;
  code: string;
  title: string;
  shortDescription: string;
  description?: string;
  color?: string;
  category: "People" | "Prosperity" | "Planet" | "Peace" | "Partnership";
  targetCount: number;
}
