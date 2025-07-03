const mongoose=require('mongoose')

const htmlContentSchema=mongoose.Schema({
    htmlContent:Buffer,
    fileName:String
})

const htmlContentModel=mongoose.model('htmlContent',htmlContentSchema)

module.exports=htmlContentModel;    