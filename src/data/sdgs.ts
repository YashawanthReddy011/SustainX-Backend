import type { SDG } from "../types";

// Official UN goal names, pillars, and target counts. This is seed data only;
// application pages read SDGs from MongoDB through the API.
export const sdgs: SDG[] = [
	{ id: 1, code: "SDG 1", title: "No Poverty", shortDescription: "End poverty in all its forms everywhere.", color: "#E5243B", category: "People", targetCount: 7 },
	{ id: 2, code: "SDG 2", title: "Zero Hunger", shortDescription: "End hunger, achieve food security and improved nutrition and promote sustainable agriculture.", color: "#DDA63A", category: "People", targetCount: 8 },
	{ id: 3, code: "SDG 3", title: "Good Health and Well-being", shortDescription: "Ensure healthy lives and promote well-being for all at all ages.", color: "#4C9F38", category: "People", targetCount: 13 },
	{ id: 4, code: "SDG 4", title: "Quality Education", shortDescription: "Ensure inclusive and equitable quality education and promote lifelong learning opportunities for all.", color: "#C5192D", category: "People", targetCount: 10 },
	{ id: 5, code: "SDG 5", title: "Gender Equality", shortDescription: "Achieve gender equality and empower all women and girls.", color: "#FF3A21", category: "People", targetCount: 9 },
	{ id: 6, code: "SDG 6", title: "Clean Water and Sanitation", shortDescription: "Ensure availability and sustainable management of water and sanitation for all.", color: "#26BDE2", category: "Planet", targetCount: 8 },
	{ id: 7, code: "SDG 7", title: "Affordable and Clean Energy", shortDescription: "Ensure access to affordable, reliable, sustainable and modern energy for all.", color: "#FCC30B", category: "Prosperity", targetCount: 5 },
	{ id: 8, code: "SDG 8", title: "Decent Work and Economic Growth", shortDescription: "Promote sustained, inclusive and sustainable economic growth, full and productive employment and decent work for all.", color: "#A21942", category: "Prosperity", targetCount: 12 },
	{ id: 9, code: "SDG 9", title: "Industry, Innovation and Infrastructure", shortDescription: "Build resilient infrastructure, promote inclusive and sustainable industrialization and foster innovation.", color: "#FD6925", category: "Prosperity", targetCount: 8 },
	{ id: 10, code: "SDG 10", title: "Reduced Inequalities", shortDescription: "Reduce inequality within and among countries.", color: "#DD1367", category: "Prosperity", targetCount: 10 },
	{ id: 11, code: "SDG 11", title: "Sustainable Cities and Communities", shortDescription: "Make cities and human settlements inclusive, safe, resilient and sustainable.", color: "#FD9D24", category: "Prosperity", targetCount: 10 },
	{ id: 12, code: "SDG 12", title: "Responsible Consumption and Production", shortDescription: "Ensure sustainable consumption and production patterns.", color: "#BF8B2E", category: "Planet", targetCount: 11 },
	{ id: 13, code: "SDG 13", title: "Climate Action", shortDescription: "Take urgent action to combat climate change and its impacts.", color: "#3F7E44", category: "Planet", targetCount: 5 },
	{ id: 14, code: "SDG 14", title: "Life Below Water", shortDescription: "Conserve and sustainably use the oceans, seas and marine resources for sustainable development.", color: "#0A97D9", category: "Planet", targetCount: 10 },
	{ id: 15, code: "SDG 15", title: "Life on Land", shortDescription: "Protect, restore and promote sustainable use of terrestrial ecosystems, sustainably manage forests, combat desertification, and halt and reverse land degradation and halt biodiversity loss.", color: "#56C02B", category: "Planet", targetCount: 12 },
	{ id: 16, code: "SDG 16", title: "Peace, Justice and Strong Institutions", shortDescription: "Promote peaceful and inclusive societies, provide access to justice for all and build effective, accountable and inclusive institutions at all levels.", color: "#00689D", category: "Peace", targetCount: 12 },
	{ id: 17, code: "SDG 17", title: "Partnerships for the Goals", shortDescription: "Strengthen the means of implementation and revitalize the Global Partnership for Sustainable Development.", color: "#19486A", category: "Partnership", targetCount: 19 },
];
